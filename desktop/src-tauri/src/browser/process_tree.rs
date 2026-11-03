//! OS ownership for one Chromium launch, not a name/PID search-and-kill helper.
//! Unix keeps the unreaped process-group leader reserved until its group exits;
//! Windows starts suspended, assigns a kill-on-close Job, then resumes it.
use std::io;
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};

const TERMINATION_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(20);

pub(super) struct OwnedProcess {
    child: Child,
    finished: bool,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}

impl OwnedProcess {
    pub(in crate::browser) fn id(&self) -> u32 {
        self.child.id()
    }

    #[cfg(unix)]
    pub(in crate::browser) fn spawn(command: &mut Command) -> io::Result<Self> {
        use std::os::unix::process::CommandExt as _;
        // setpgid(0, 0) runs before exec, not in a racy parent-side follow-up.
        // No unrelated client/user Chromium belongs to this new process group.
        let child = command.process_group(0).spawn()?;
        Ok(Self {
            child,
            finished: false,
        })
    }

    #[cfg(unix)]
    pub(in crate::browser) fn has_exited(&self) -> io::Result<bool> {
        if self.finished {
            return Ok(true);
        }
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: info points to correctly sized writable siginfo_t storage.
        // WNOWAIT deliberately does not reap: pid/pgid cannot be reused while
        // other threads are closing this session. Only terminate calls wait.
        let status = unsafe {
            libc::waitid(
                libc::P_PID,
                self.id() as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if status != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful waitid initialized the zeroed siginfo_t. si_pid is
        // available for the WEXITED events requested above on Linux and macOS.
        Ok(unsafe { info.assume_init().si_pid() } != 0)
    }

    #[cfg(unix)]
    pub(in crate::browser) fn request_polite_exit(&self) {
        if !self.finished {
            // SAFETY: pid is our unreaped child, never a recycled foreign pid.
            unsafe { libc::kill(self.id() as i32, libc::SIGTERM) };
        }
    }

    #[cfg(unix)]
    pub(in crate::browser) fn terminate(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        // Confirm we still own the unreaped child before addressing its group.
        self.has_exited()?;
        let group = self.id() as i32;
        if group <= 1 {
            return Err(io::Error::other("invalid owned Chromium process group"));
        }
        // macOS returns EPERM from kill(-pgid, SIGKILL) once every member is a
        // zombie or already inside kernel exit1() (P_LPEXIT). Because a dying
        // helper in P_LPEXIT can still appear as non-Z in ps for a few
        // milliseconds before becoming SZOMB, keep polling until the deadline
        // rather than failing on the first EPERM snapshot.
        if self.has_exited()? && !group_has_live_members(group)? {
            self.child.wait()?;
            self.finished = true;
            return Ok(());
        }
        let deadline = Instant::now() + TERMINATION_TIMEOUT;
        let mut last_kill_error: Option<io::Error> = None;
        loop {
            // SAFETY: this group was created before exec for this child, whose
            // pid remains reserved. Negative pid addresses only that exact group.
            if unsafe { libc::kill(-group, libc::SIGKILL) } != 0 {
                let error = io::Error::last_os_error();
                if !matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::EPERM)) {
                    return Err(error);
                }
                last_kill_error = Some(error);
            }
            // A terminated descendant may remain a zombie until the system
            // reaps it. Zombies cannot execute or hold profile files, so they
            // are safe; a mere parent wait/kill(-pgid, 0) cannot establish this.
            if self.has_exited()? && !group_has_live_members(group)? {
                self.child.wait()?;
                self.finished = true;
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(last_kill_error.unwrap_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "owned Chromium process group did not finish exiting",
                    )
                }));
            }
            thread::sleep(POLL);
        }
    }
}

#[cfg(unix)]
fn group_has_live_members(group: i32) -> io::Result<bool> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pgid=,stat="])
        .stdin(std::process::Stdio::null())
        .output()?;
    if !output.status.success() || !output.stderr.is_empty() {
        return Err(io::Error::other(
            "cannot inspect owned Chromium process group",
        ));
    }
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| io::Error::other("invalid process status output"))?;
    live_group_in_snapshot(text, group)
}

#[cfg(unix)]
fn live_group_in_snapshot(text: &str, group: i32) -> io::Result<bool> {
    if text.trim().is_empty() {
        return Err(io::Error::other("empty process status snapshot"));
    }
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        let id = fields
            .next()
            .and_then(|value| value.parse::<i32>().ok())
            .ok_or_else(|| io::Error::other("invalid process group in snapshot"))?;
        let status = fields
            .next()
            .ok_or_else(|| io::Error::other("missing process status"))?;
        if fields.next().is_some() {
            return Err(io::Error::other("unexpected process status fields"));
        }
        if id == group && !status.starts_with('Z') {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt as _;
    use windows_sys::Win32::Foundation::{
        HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, WaitForSingleObject, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    fn owned_handle(handle: HANDLE) -> io::Result<OwnedHandle> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: a newly returned, uniquely owned Win32 handle.
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        }
    }

    fn resume_suspended_child(child: &Child) -> io::Result<()> {
        // std::process retains the process handle but closes the primary thread
        // handle. A CREATE_SUSPENDED child has exactly one thread and cannot
        // race us by spawning more; locate that thread by this pinned pid.
        let snapshot = owned_handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut present = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
        while present {
            if entry.th32OwnerProcessID == child.id() {
                let thread = owned_handle(unsafe {
                    OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID)
                })?;
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            present = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
        }
        Err(io::Error::other(
            "cannot find suspended Chromium primary thread",
        ))
    }

    impl OwnedProcess {
        pub(in crate::browser) fn spawn(command: &mut Command) -> io::Result<Self> {
            let job =
                owned_handle(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            // No BREAKAWAY_OK: descendants cannot outlive this launch's Job.
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut child = command.creation_flags(CREATE_SUSPENDED).spawn()?;
            if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0
            {
                let error = io::Error::last_os_error();
                // Child never ran, therefore cannot have touched the profile or
                // spawned descendants. Keep failure closed rather than falling
                // back to an unowned/taskkill browser.
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            if let Err(error) = resume_suspended_child(&child) {
                unsafe { TerminateJobObject(job.as_raw_handle(), 1) };
                let _ = child.wait();
                return Err(error);
            }
            Ok(Self {
                child,
                job,
                finished: false,
            })
        }

        pub(in crate::browser) fn has_exited(&self) -> io::Result<bool> {
            if self.finished {
                return Ok(true);
            }
            // Process handle, not a pid probe: safe after parent death/reuse.
            match unsafe { WaitForSingleObject(self.child.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => Ok(true),
                WAIT_TIMEOUT => Ok(false),
                _ => Err(io::Error::last_os_error()),
            }
        }

        pub(in crate::browser) fn request_polite_exit(&self) {
            // Only the graceful fallback uses taskkill. The force path below
            // always terminates the owned Job, never a discovered PID tree.
            if matches!(self.has_exited(), Ok(false)) {
                let _ = Command::new(crate::profile::system_tool("taskkill.exe"))
                    .args(["/PID", &self.id().to_string()])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .creation_flags(crate::profile::CREATE_NO_WINDOW)
                    .status();
            }
        }

        pub(in crate::browser) fn terminate(&mut self) -> io::Result<()> {
            if self.finished {
                return Ok(());
            }
            if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let deadline = Instant::now() + TERMINATION_TIMEOUT;
            loop {
                let mut status: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
                    unsafe { std::mem::zeroed() };
                if unsafe {
                    QueryInformationJobObject(
                        self.job.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        &mut status as *mut _ as *mut _,
                        std::mem::size_of_val(&status) as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if status.ActiveProcesses == 0 && self.has_exited()? {
                    self.child.wait()?;
                    self.finished = true;
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "owned Chromium Job did not finish exiting",
                    ));
                }
                thread::sleep(POLL);
            }
        }
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // Normal code only drops after terminate succeeded. Also contain a
        // launch/test failure instead of leaving a newly spawned browser alive.
        if !self.finished {
            if let Err(error) = self.terminate() {
                eprintln!("owned browser process cleanup failed: {error}");
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn group_exit_check_ignores_only_zombies_not_stopped_or_foreign_groups() {
        assert!(!live_group_in_snapshot("42 Z\n420 R\n", 42).unwrap());
        assert!(live_group_in_snapshot("42 T\n", 42).unwrap());
        assert!(live_group_in_snapshot("42 S+\n", 42).unwrap());
        assert!(live_group_in_snapshot("", 42).is_err());
        assert!(live_group_in_snapshot("42\n", 42).is_err());
        assert!(live_group_in_snapshot("bad S\n", 42).is_err());
    }
}

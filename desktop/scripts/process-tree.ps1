# One owned process tree, established before the child executes. No global taskkill or ACL changes.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class VestusOwnedJob {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xCount,yCount,fill,flags;
    public short show, reserved2Count; public IntPtr reserved2, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
    public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user, kernel, periodUser, periodKernel;
    public uint faults, total, active, terminated;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref ExtendedLimit limit,int length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,out Accounting accounting,int length,IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static Exception Error(string operation) { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); }
      else { result.Append('\\',slashes); result.Append(c); }
      slashes=0;
    }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }
  public static int Run(string executable,string[] args,string acknowledgement) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw Error("CreateJobObject");
    ProcessInfo process = new ProcessInfo(); bool assigned=false; IntPtr input=IntPtr.Zero;
    try {
      var limits=new ExtendedLimit(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
      if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))) throw Error("SetInformationJobObject");
      var command=new StringBuilder(Quote(executable));
      foreach(string arg in args) command.Append(' ').Append(Quote(arg));
      var startup=new Startup(); startup.cb=Marshal.SizeOf(startup); startup.flags=0x100;
      // Do not let the child consume the parent stop pipe or know the cleanup acknowledgement.
      var security=new Security(); security.length=Marshal.SizeOf(security); security.inherit=1;
      input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);
      if(input==new IntPtr(-1)) throw Error("CreateFile NUL");
      if(!SetHandleInformation(GetStdHandle(-10),1,0)) throw Error("protect parent stop pipe");
      if(!SetHandleInformation(GetStdHandle(-11),1,1) || !SetHandleInformation(GetStdHandle(-12),1,1)) throw Error("inherit output pipes");
      startup.input=input; startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
      Environment.SetEnvironmentVariable("VESTUS_OWNED_ACK",null);
      Environment.SetEnvironmentVariable("VESTUS_OWNED_COMMAND",null);
      if(!CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,null,ref startup,out process)) throw Error("CreateProcess suspended");
      if(!AssignProcessToJobObject(job,process.process)) throw Error("AssignProcessToJobObject");
      assigned=true;
      if(ResumeThread(process.thread)==0xffffffff) throw Error("ResumeThread");
      // Parent pipe EOF requests stop; a wrapper crash also closes the kill-on-close job.
      bool stop=false;
      var reader=new Thread(()=>{ try { Console.In.ReadToEnd(); } finally { Volatile.Write(ref stop,true); } });
      reader.IsBackground=true; reader.Start();
      while(WaitForSingleObject(process.process,20)==0x102 && !Volatile.Read(ref stop)) {}
      uint exit=1; GetExitCodeProcess(process.process,out exit);
      if(!TerminateJobObject(job,1)) throw Error("TerminateJobObject");
      var deadline=DateTime.UtcNow.AddSeconds(4);
      while(true) {
        Accounting accounting;
        if(!QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw Error("QueryInformationJobObject");
        if(accounting.active==0) break;
        if(DateTime.UtcNow>=deadline) throw new Exception("owned Job exit timeout");
        Thread.Sleep(20);
      }
      Console.Error.WriteLine("VESTUS_OWNED_JOB_EMPTY:"+acknowledgement);
      return Volatile.Read(ref stop) ? 1 : unchecked((int)exit);
    } finally {
      if(!assigned && process.process!=IntPtr.Zero) { TerminateProcess(process.process,1); WaitForSingleObject(process.process,4000); }
      if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input);
      if(process.thread!=IntPtr.Zero) CloseHandle(process.thread);
      if(process.process!=IntPtr.Zero) CloseHandle(process.process);
      CloseHandle(job);
    }
  }
}
'@
try {
  $config = $env:VESTUS_OWNED_COMMAND | ConvertFrom-Json
  exit [VestusOwnedJob]::Run([string]$config.command, [string[]]$config.args, [string]$env:VESTUS_OWNED_ACK)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

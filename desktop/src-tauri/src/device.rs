//! The machine identifier the operating system exposes.
//!
//! Read once per process and cached: the value is needed on login and on every
//! activity flush, and both paths must stay cheap.  Collection is strictly
//! best-effort -- a failure returns `None` and the client simply reports no
//! device id.  Nothing here may ever block a login: a Windows machine whose
//! registry is locked down by policy, or a Linux container without a
//! machine-id, still has to be usable.
//!
//! Per platform:
//!
//! * macOS: `IOPlatformUUID`, read from `ioreg` (the OS-supported way to ask;
//!   the FFI alternative `gethostuuid` would be the project's first `unsafe`
//!   call, which is not worth it for one UUID).
//! * Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` through
//!   `winreg`, which keeps the parse independent of the system language.
//! * Linux: `/etc/machine-id`, falling back to `/var/lib/dbus/machine-id`.
//!
//! Known properties of all three, worth remembering when the value is used for
//! anything: it changes on an OS reinstall (Windows), on a mainboard change or
//! migration-assistant restore (macOS), may be regenerated per boot inside
//! containers (Linux), and a sysprep'd or cloned Windows image can hand the
//! same value to several machines.  Local administrators can edit it.  Treat it
//! as an audit and operations signal, never as a security boundary.

use std::sync::OnceLock;

/// Longest identifier the server accepts; longer values are dropped here so a
/// malformed read never even reaches the wire.
const MAX_DEVICE_ID_LENGTH: usize = 64;

static DEVICE_ID: OnceLock<Option<String>> = OnceLock::new();

/// The normalized machine identifier, read once per process.
///
/// `None` when the platform read failed or produced something unusable.
pub fn device_id() -> Option<&'static str> {
    DEVICE_ID.get_or_init(|| normalize(read_machine_id())).as_deref()
}

/// The value for a request body, or `None` when nothing usable was read.
pub fn wire_device_id() -> Option<String> {
    device_id().map(str::to_string)
}

/// Fold the three platform formats into the one the server stores.
///
/// macOS returns an upper-case UUID, Windows lower-case hex that tooling often
/// wraps in braces, Linux 32 lower-case hex.  Only hex digits and hyphens
/// survive; anything else -- including an empty or over-long value -- is
/// dropped rather than repaired.
pub fn normalize(raw: Option<String>) -> Option<String> {
    let text = raw?;
    let stripped = text.trim().trim_matches(['{', '}']).trim().to_lowercase();
    if stripped.is_empty() || stripped.len() > MAX_DEVICE_ID_LENGTH {
        return None;
    }
    if !stripped
        .chars()
        .all(|ch| ch.is_ascii_hexdigit() || ch == '-')
    {
        return None;
    }
    if stripped.chars().all(|ch| ch == '-') {
        return None;
    }
    Some(stripped)
}

#[cfg(target_os = "macos")]
fn read_machine_id() -> Option<String> {
    // `ioreg -rd1 -c IOPlatformExpertDevice` prints every property of the
    // platform expert device; the UUID sits on its own line as
    // `"IOPlatformUUID" = "XXXXXXXX-XXXX-..."`.
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_ioreg_output(&String::from_utf8_lossy(&output.stdout))
}

/// Pull `IOPlatformUUID` out of `ioreg` output.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_ioreg_output(text: &str) -> Option<String> {
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().trim_matches('"') != "IOPlatformUUID" {
            continue;
        }
        let value = value.trim().trim_matches('"').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn read_machine_id() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Cryptography", KEY_READ)
        .ok()?;
    let value: String = key.get_value("MachineGuid").ok()?;
    Some(value)
}

#[cfg(target_os = "linux")]
fn read_machine_id() -> Option<String> {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn read_machine_id() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_three_platform_formats_to_one() {
        // macOS.
        assert_eq!(
            normalize(Some("A1B2C3D4-E5F6-7890-ABCD-EF1234567890".into())).as_deref(),
            Some("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
        );
        // Windows, braces and stray whitespace included.
        assert_eq!(
            normalize(Some("  {A1B2C3D4E5F67890ABCDEF1234567890}  ".into())).as_deref(),
            Some("a1b2c3d4e5f67890abcdef1234567890")
        );
        // Linux.
        assert_eq!(
            normalize(Some("a1b2c3d4e5f67890abcdef1234567890\n".into())).as_deref(),
            Some("a1b2c3d4e5f67890abcdef1234567890")
        );
    }

    #[test]
    fn drops_values_it_cannot_trust() {
        assert_eq!(normalize(None), None);
        assert_eq!(normalize(Some("   ".into())), None);
        assert_eq!(normalize(Some("{}".into())), None);
        assert_eq!(normalize(Some("--------".into())), None);
        // Not hex: a hostname or a placeholder must not be stored as a device.
        assert_eq!(normalize(Some("my-laptop.local".into())), None);
        assert_eq!(normalize(Some("未知设备".into())), None);
        assert_eq!(normalize(Some("a".repeat(MAX_DEVICE_ID_LENGTH + 1))), None);
    }

    #[test]
    fn reads_the_uuid_out_of_ioreg_output() {
        let sample = r#"
+-o J314sAP  <class IOPlatformExpertDevice, id 0x100000123, registered, matched, active, busy 0 (0 ms), retain 8>
    {
      "IOPlatformSerialNumber" = "C02XXXXXXXXX"
      "IOPlatformUUID" = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
      "product-name" = "MacBook Pro"
    }
"#;
        assert_eq!(
            parse_ioreg_output(sample).as_deref(),
            Some("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")
        );
        assert_eq!(parse_ioreg_output("no uuid here"), None);
    }

    #[test]
    fn caches_the_value_for_the_process() {
        // Both call styles answer from the same cache, so a login and every
        // activity flush cannot disagree about the machine.
        assert_eq!(device_id(), device_id());
        assert_eq!(wire_device_id().as_deref(), device_id());
    }
}

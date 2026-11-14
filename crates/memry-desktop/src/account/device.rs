//! What `POST /auth/devices` says about this install, as Electron sends it
//! (`sync/device-registration.ts:81-92`): the host name, the platform, the OS version and the app
//! version. No form factor (Electron sends none; readers fall back to the platform) and no vault
//! id: registration from the account screen happens before a vault is bound, and binding the open
//! vault at registration is the adopt step of lane A4.

use memry_core::api::auth::DeviceDescriptor;
use memry_core::protocol::auth::DevicePlatform;

pub fn descriptor(app_version: &str) -> DeviceDescriptor {
    let host = gethostname::gethostname()
        .to_string_lossy()
        .trim()
        .to_owned();
    DeviceDescriptor {
        // The server refuses an empty name; Electron's `os.hostname()` is never empty either.
        name: if host.is_empty() {
            "Desktop".to_owned()
        } else {
            host
        },
        platform: platform(),
        form_factor: None,
        os_version: Some(os_info::get().version().to_string()),
        app_version: app_version.to_owned(),
        vault_id: None,
    }
}

/// `PLATFORM_MAP` (`device-registration.ts:52-56`), with Linux as the fallback.
fn platform() -> DevicePlatform {
    if cfg!(target_os = "macos") {
        DevicePlatform::Macos
    } else if cfg!(windows) {
        DevicePlatform::Windows
    } else {
        DevicePlatform::Linux
    }
}

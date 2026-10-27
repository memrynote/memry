use objc2_service_management::{SMAppService, SMAppServiceStatus};
use tauri::{AppHandle, Wry};

/// `SMAppService::mainAppService()` is the login item of the running bundle. Outside a bundle
/// (a dev binary) it fails and the failure is reported.
pub fn apply(_app: &AppHandle<Wry>, enabled: bool) -> Result<(), String> {
    // SAFETY: plain Objective-C calls on the shared main-app service; no pointers are passed.
    let (service, status) = unsafe {
        let service = SMAppService::mainAppService();
        let status = service.status();
        (service, status)
    };
    let registered =
        status == SMAppServiceStatus::Enabled || status == SMAppServiceStatus::RequiresApproval;
    if enabled == registered {
        return Ok(());
    }
    // SAFETY: as above.
    let result = unsafe {
        if enabled {
            service.registerAndReturnError()
        } else {
            service.unregisterAndReturnError()
        }
    };
    result.map_err(|error| error.localizedDescription().to_string())
}

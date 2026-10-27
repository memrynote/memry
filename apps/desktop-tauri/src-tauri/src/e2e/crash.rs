use crate::commands::error::{CommandError, ErrorKind};

/// Crashes the process the way a native fault does: the crash handler asks the monitor for a
/// minidump, then the process ends. The reply never returns.
#[tauri::command]
pub fn e2e_trigger_crash() -> Result<(), CommandError> {
    if crate::guards::crash_dump::simulate_crash() {
        return Ok(());
    }
    Err(CommandError::new(
        ErrorKind::Invalid,
        "e2e_crash",
        "the crash handler is not attached",
    ))
}

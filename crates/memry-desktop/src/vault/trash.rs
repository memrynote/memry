//! The OS trash (`shell.trashItem` of desktop Electron): the Recycle Bin on Windows, the
//! Trash on macOS, the freedesktop.org trash on Linux. A file the app gives up on goes here,
//! never away for good, so the user can take it back.

use std::path::Path;

/// Moves the file or folder at `path` to the OS trash.
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    context().delete(path).map_err(|error| error.to_string())
}

/// On macOS, `NSFileManager.trashItem` as Electron's `shell.trashItem` does. The crate's
/// default asks the Finder through AppleScript, which needs the user's Automation permission
/// and waits on its prompt.
fn context() -> trash::TrashContext {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context
}

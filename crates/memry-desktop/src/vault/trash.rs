//! The OS trash (`shell.trashItem` of desktop Electron): the Recycle Bin on Windows, the
//! Trash on macOS, the freedesktop.org trash on Linux. A file the app gives up on goes here,
//! never away for good, so the user can take it back.

use std::io;
use std::path::Path;
use std::time::Duration;

use crate::vault::fs_atomic::{RETRY_DELAYS_MS, with_transient_retry};

/// What `trash` reports on Windows when the shell's `IFileOperation` aborted the delete. The
/// crate drops the reason (its own `TODO`), and this is its only `Unknown` error there.
const WINDOWS_ABORTED: &str = "Some operations were aborted";

/// Moves the file or folder at `path` to the OS trash.
///
/// The Windows shell refuses a folder for a moment while a virus scanner, a cloud-sync client or
/// the indexer holds something in it (`COPYENGINE_E_ACCESS_DENIED_SRC`; 3 of 566 runs of one
/// test on a Windows ARM runner, #4668). Nothing is held a few milliseconds later, so an abort
/// is retried on the schedule every other vault write uses (`fs_atomic::with_transient_retry`).
/// A retry after a partial move takes the rest of the folder.
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    with_transient_retry(&delays, || {
        context().delete(path).map_err(|error| {
            let kind = match &error {
                trash::Error::Unknown { description } if description == WINDOWS_ABORTED => {
                    io::ErrorKind::ResourceBusy
                }
                _ => io::ErrorKind::Other,
            };
            io::Error::new(kind, error.to_string())
        })
    })
    .map_err(|error| error.to_string())
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

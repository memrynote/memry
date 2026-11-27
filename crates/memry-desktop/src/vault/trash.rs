//! The OS trash (`shell.trashItem` of desktop Electron): the Recycle Bin on Windows, the
//! Trash on macOS, the freedesktop.org trash on Linux. A file the app gives up on goes here,
//! never away for good, so the user can take it back.

use std::fs;
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
/// A retry after a partial move takes the rest of the folder, and one after an abort that moved
/// everything finds nothing left at `path`: that delete is done.
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    trash_with(path, |path| context().delete(path))
}

/// [`move_to_trash`] through `delete`, the shell's trash call.
fn trash_with(
    path: &Path,
    delete: impl Fn(&Path) -> Result<(), trash::Error>,
) -> Result<(), String> {
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let mut retry = false;
    with_transient_retry(&delays, || {
        if std::mem::replace(&mut retry, true)
            && fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        {
            return Ok(());
        }
        delete(path).map_err(|error| {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell that moves the file to the trash, then reports the abort, as Windows'
    /// `IFileOperation` can after a partial move; a path no longer there is refused as the
    /// crate refuses one.
    fn moves_then_aborts(bin: &Path) -> impl Fn(&Path) -> Result<(), trash::Error> + '_ {
        move |path| {
            if std::fs::symlink_metadata(path).is_err() {
                return Err(trash::Error::Unknown {
                    description: "not there".into(),
                });
            }
            std::fs::rename(path, bin.join("a.md")).unwrap();
            Err(trash::Error::Unknown {
                description: WINDOWS_ABORTED.into(),
            })
        }
    }

    #[test]
    fn an_aborted_delete_that_moved_everything_is_done() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, bin) = (dir.path().join("vault"), dir.path().join("bin"));
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let note = vault.join("a.md");
        std::fs::write(&note, "a").unwrap();

        assert_eq!(trash_with(&note, moves_then_aborts(&bin)), Ok(()));
        assert!(bin.join("a.md").exists());
    }

    #[test]
    fn an_aborted_delete_that_moved_nothing_still_fails() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("a.md");
        std::fs::write(&note, "a").unwrap();

        let refused = trash_with(&note, |_| {
            Err(trash::Error::Unknown {
                description: WINDOWS_ABORTED.into(),
            })
        });
        assert!(refused.is_err());
        assert!(note.exists());
    }
}

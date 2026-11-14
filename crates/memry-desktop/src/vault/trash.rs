//! The OS trash (`shell.trashItem` of desktop Electron): the Recycle Bin on Windows, the
//! Trash on macOS, the freedesktop.org trash on Linux. A file the app gives up on goes here,
//! never away for good, so the user can take it back.

use std::path::Path;

/// Moves the file or folder at `path` to the OS trash.
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    let first = context().delete(path);
    match first {
        Ok(()) => Ok(()),
        Err(error) => {
            probe_dump(path);
            let again = context().delete(path);
            eprintln!("PROBE4668 retry after failure: {again:?}");
            Err(error.to_string())
        }
    }
}

fn probe_dump(path: &Path) {
    use std::os::windows::fs::OpenOptionsExt;
    eprintln!("PROBE4668 first delete failed for {}", path.display());
    fn walk(p: &Path, depth: usize) {
        let Ok(rd) = std::fs::read_dir(p) else {
            eprintln!("PROBE4668 {:indent$}cannot list {}", "", p.display(), indent = depth * 2);
            return;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let meta = entry.metadata().ok();
            let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
            let locked = if is_dir {
                String::new()
            } else {
                match std::fs::OpenOptions::new().read(true).share_mode(0).open(&path) {
                    Ok(_) => "unlocked".to_owned(),
                    Err(e) => format!("LOCKED {e}"),
                }
            };
            eprintln!("PROBE4668 {:indent$}{} {}", "", path.display(), locked, indent = depth * 2);
            if is_dir {
                walk(&path, depth + 1);
            }
        }
    }
    walk(path, 1);
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

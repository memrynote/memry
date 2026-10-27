//! "Is this file really gone" and "is the vault there at all": the checks a removal passes
//! before it may reach anything (`vault/gone-from-disk.ts`, `isVaultReachable`).

use std::io::ErrorKind;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presence {
    Gone,
    Present,
    Unreadable,
}

fn presence(path: &Path) -> Presence {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Presence::Present,
        Err(error) if error.kind() == ErrorKind::NotFound => Presence::Gone,
        // `ENOTDIR`: a folder above the file became a file.
        #[cfg(unix)]
        Err(error) if error.raw_os_error() == Some(libc::ENOTDIR) => Presence::Gone,
        Err(_) => Presence::Unreadable,
    }
}

/// True only when the file and its iCloud placeholder are both absent. A file that cannot be
/// looked at (`EACCES`, `EIO`, a share that timed out, an antivirus lock) may still be there, so
/// it is kept (#2764). iCloud before macOS 14 swaps an evicted file for a hidden
/// `.<name>.icloud` placeholder: still in the vault, only not downloaded (#3004).
///
/// The caller checks [`is_vault_reachable`] first: an unmounted vault hides every file at once.
pub fn is_gone_from_disk(path: &Path) -> bool {
    match presence(path) {
        Presence::Present => return false,
        Presence::Unreadable => {
            tracing::warn!(scope = "vault_watch", "a file cannot be looked at; keeping it");
            return false;
        }
        Presence::Gone => {}
    }
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return true;
    };
    let placeholder = dir.join(format!(".{}.icloud", name.to_string_lossy()));
    presence(&placeholder) == Presence::Gone
}

/// The vault is mounted: its database file is there. A removable or network vault that is
/// away for a moment, or a vault folder renamed away, hides every file at once. `.memry`
/// alone proves nothing, since a writer can recreate it where a vault used to be.
pub fn is_vault_reachable(vault: &Path) -> bool {
    std::fs::metadata(vault.join(".memry/core/data.db")).is_ok_and(|m| m.is_file())
}

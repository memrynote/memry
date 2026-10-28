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
            tracing::warn!(
                scope = "vault_watch",
                "a file cannot be looked at; keeping it"
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vault_is_reachable_only_while_its_database_file_is_there() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_vault_reachable(dir.path()));
        std::fs::create_dir_all(dir.path().join(".memry/core")).unwrap();
        assert!(
            !is_vault_reachable(dir.path()),
            "`.memry` alone proves nothing"
        );
        std::fs::write(dir.path().join(".memry/core/data.db"), "x").unwrap();
        assert!(is_vault_reachable(dir.path()));
    }

    #[test]
    fn a_file_is_gone_only_when_it_and_its_icloud_placeholder_are_absent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        assert!(is_gone_from_disk(&file));
        std::fs::write(&file, "x").unwrap();
        assert!(!is_gone_from_disk(&file));
        std::fs::remove_file(&file).unwrap();
        std::fs::write(dir.path().join(".a.md.icloud"), "stub").unwrap();
        assert!(!is_gone_from_disk(&file), "evicted to iCloud, not deleted");
    }

    #[test]
    fn a_missing_folder_above_the_file_counts_as_gone() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_gone_from_disk(&dir.path().join("no/such/a.md")));
    }
}

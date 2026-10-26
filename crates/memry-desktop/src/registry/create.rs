//! Creating a vault folder: the naming rules of `createVault`.

use std::path::{Path, PathBuf};

/// Why a vault could not be created. The two coded reasons are part of the IPC contract
/// (`errorCode` of `SelectVaultResponse`).
#[derive(Debug, thiserror::Error)]
pub enum CreateError {
    #[error("Vault name contains characters that cannot be used in a folder name")]
    InvalidName,
    #[error("A folder with this name already exists here")]
    AlreadyExists,
    #[error("{0}")]
    Io(String),
}

impl CreateError {
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::InvalidName => Some("invalid-name"),
            Self::AlreadyExists => Some("already-exists"),
            Self::Io(_) => None,
        }
    }
}

/// Non-empty, not hidden (a leading dot would hide the folder on macOS and Linux), and none
/// of the separators, NUL or characters Windows rejects in a file name.
pub fn is_valid_folder_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.chars().any(|c| {
            matches!(
                c,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'
            )
        })
}

/// Creates `<parent>/<name>` and returns its path. Refuses an existing folder: adopting
/// existing files is what "open folder as vault" is for, and silently opening a folder the
/// user did not mean to pick mixes notes into the wrong directory.
pub fn create_vault_folder(parent: &Path, name: &str) -> Result<PathBuf, CreateError> {
    let name = name.trim();
    if !is_valid_folder_name(name) {
        return Err(CreateError::InvalidName);
    }
    let target = parent.join(name);
    if target
        .try_exists()
        .map_err(|err| CreateError::Io(err.to_string()))?
    {
        return Err(CreateError::AlreadyExists);
    }
    std::fs::create_dir_all(parent).map_err(|err| CreateError::Io(err.to_string()))?;
    std::fs::create_dir(&target).map_err(|err| CreateError::Io(err.to_string()))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_follow_the_electron_rules() {
        for ok in ["Notes", "my vault", "Ödeme Toplantısı", "a.b", "日本語"] {
            assert!(is_valid_folder_name(ok), "{ok}");
        }
        for bad in [
            "", ".hidden", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\0b",
        ] {
            assert!(!is_valid_folder_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn an_existing_folder_is_never_reused() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::create_dir(dir.path().join("Taken")).expect("seed");
        let err = create_vault_folder(dir.path(), "Taken").expect_err("exists");
        assert_eq!(err.code(), Some("already-exists"));
        let err = create_vault_folder(dir.path(), " .x ").expect_err("invalid");
        assert_eq!(err.code(), Some("invalid-name"));
        let made =
            create_vault_folder(&dir.path().join("nested/parent"), "  New  ").expect("create");
        assert!(made.is_dir() && made.ends_with("New"));
    }
}

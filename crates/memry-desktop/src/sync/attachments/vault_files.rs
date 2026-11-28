//! The vault folder as core's attachment runners read it ([`VaultFiles`]).

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use memry_core::sync::attachments::queue::VaultFiles;

use crate::shell::file_open::OpenError;
use crate::vault::paths::open_vault_file;
use crate::vault::watch::gone::is_vault_reachable;

pub struct DesktopVaultFiles(PathBuf);

impl DesktopVaultFiles {
    pub fn new(root: PathBuf) -> Self {
        Self(root)
    }
}

impl VaultFiles for DesktopVaultFiles {
    fn root(&self) -> &Path {
        &self.0
    }

    /// Through the vault-root check: a link or a `..` never leads an upload outside the vault.
    fn open(&self, rel: &str) -> io::Result<File> {
        match open_vault_file(&self.0, rel) {
            Ok(Some(file)) => Ok(file),
            Ok(None) => Err(io::ErrorKind::NotFound.into()),
            Err(OpenError::Io(error)) => Err(error),
            Err(error) => Err(io::Error::other(error)),
        }
    }

    fn list_files(&self, rel_dir: &str) -> io::Result<Vec<String>> {
        if rel_dir.split('/').any(|part| part == "..") {
            return Err(io::Error::other("outside the vault"));
        }
        let mut names = Vec::new();
        for entry in std::fs::read_dir(self.0.join(rel_dir))? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        names.sort();
        Ok(names)
    }

    /// Electron's `isVaultReachable`: the database file is there.
    fn is_reachable(&self) -> bool {
        is_vault_reachable(&self.0)
    }
}

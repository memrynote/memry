//! The paths a copy into the vault may read (`notes:import-files`; Step 32h1, #3549, the
//! requirement of #3709 in comment 6475747288).
//!
//! The renderer names the files, and a renderer that runs hostile code must not be able to copy
//! `~/.ssh/id_rsa` into the vault, which sync then uploads. So a path is read only when it is:
//! - under the drop staging root (`shell::drop_stage`), where the shell copies only files the
//!   user dropped from the OS; or
//! - one the import dialog returned, the last time it was shown, and not read since.
//!
//! Each path is resolved through every link and `..` first, so neither leaves the staging root,
//! and the resolved path is what the copy reads. One path outside both refuses the whole call,
//! before any file is read. A path that does not resolve (the file is gone) reads nothing and
//! fails alone, as Electron's `fs.access` failed it.
//!
//! Electron read any path the renderer sent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Why [`ImportGrants::admit`] refused a call.
#[derive(Debug, thiserror::Error)]
pub enum SourceRefused {
    #[error("a file outside the dropped files and the import dialog's answer was named")]
    NotAllowed,
}

/// A file a copy may read, from [`ImportGrants::admit`] only.
#[derive(Debug)]
pub struct ImportSource {
    /// The file name the renderer named, which the copy keeps (`path.basename(sourcePath)`).
    pub(crate) name: String,
    /// The path the copy reads, every link and `..` resolved; the error when it does not
    /// resolve.
    pub(crate) resolved: Result<PathBuf, String>,
}

/// The import dialog's last answer, which [`ImportGrants::admit`] reads once.
#[derive(Debug, Default)]
pub struct ImportGrants {
    granted: Mutex<HashSet<PathBuf>>,
}

impl ImportGrants {
    /// The paths the import dialog returned; they replace any earlier dialog's.
    pub fn grant(&self, picked: &[PathBuf]) {
        let resolved = picked
            .iter()
            .filter_map(|path| path.canonicalize().ok())
            .collect();
        *self.lock() = resolved;
    }

    /// The files of `paths` a copy may read, or the refusal of all of them (module doc). The
    /// dialog's paths it admits are not admitted again.
    pub fn admit(
        &self,
        staging_root: &Path,
        paths: &[String],
    ) -> Result<Vec<ImportSource>, SourceRefused> {
        let root = staging_root.canonicalize().ok();
        let mut granted = self.lock();
        let mut taken = Vec::new();
        let mut sources = Vec::with_capacity(paths.len());
        for path in paths {
            let path = Path::new(path);
            let resolved = path.canonicalize();
            if let Ok(real) = &resolved {
                let staged = root.as_deref().is_some_and(|root| real.starts_with(root));
                if !staged && !granted.contains(real) {
                    tracing::warn!(
                        scope = "import",
                        "an import named a file that was neither dropped nor picked; refused"
                    );
                    return Err(SourceRefused::NotAllowed);
                }
                if !staged {
                    taken.push(real.clone());
                }
            }
            let name = path
                .file_name()
                .or_else(|| resolved.as_ref().ok().and_then(|real| real.file_name()))
                .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
            sources.push(ImportSource {
                name,
                resolved: resolved.map_err(|error| error.to_string()),
            });
        }
        for real in taken {
            granted.remove(&real);
        }
        Ok(sources)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<PathBuf>> {
        self.granted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

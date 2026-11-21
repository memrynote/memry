//! The paths a copy into the vault may read (`notes:import-files`; Step 32h1, #3549, the
//! requirement of #3709 in comment 6475747288).
//!
//! The renderer names the files, and a renderer that runs hostile code must not be able to copy
//! `~/.ssh/id_rsa` into the vault, which sync then uploads. So a path is read only when it is:
//! - under the drop staging root (`shell::drop_stage`), where the shell copies only files the
//!   user dropped from the OS; or
//! - one the import dialog returned, the last time it was shown, and not read since.
//!
//! Each path is decided as the renderer spelled it first, with no disk access: under the
//! staging root with only plain names below it (no `..`), or exactly a string the dialog
//! returned. One path that is neither refuses the whole call, so whether a path exists, or what
//! a share or automount behind it holds, is never looked up for the renderer. Only then is each
//! path resolved through every link and `..`, and the resolved path must still be under the
//! staging root, or be the file the dialog's string resolved to when it was picked; it is what
//! the copy reads. A path that does not resolve (the file is gone) reads nothing and fails
//! alone, as Electron's `fs.access` failed it.
//!
//! Electron read any path the renderer sent.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
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

/// The import dialog's last answer, which [`ImportGrants::admit`] reads once: each string it
/// returned, and the file that string resolved to then.
#[derive(Debug, Default)]
pub struct ImportGrants {
    granted: Mutex<HashMap<String, PathBuf>>,
}

/// Why a path of a call may be read, decided from its spelling alone.
enum Claim {
    Staged,
    /// The file the dialog's string resolved to when it was picked.
    Picked(PathBuf),
}

impl ImportGrants {
    /// The paths the import dialog returned; they replace any earlier dialog's.
    pub fn grant(&self, picked: &[PathBuf]) {
        let granted = picked
            .iter()
            .filter_map(|path| {
                Some((
                    path.to_string_lossy().into_owned(),
                    path.canonicalize().ok()?,
                ))
            })
            .collect();
        *self.lock() = granted;
    }

    /// The files of `paths` a copy may read, or the refusal of all of them (module doc). Each
    /// pick admits its file once; a refused call takes none.
    pub fn admit(
        &self,
        staging_root: &Path,
        paths: &[String],
    ) -> Result<Vec<ImportSource>, SourceRefused> {
        let mut granted = self.lock();
        let mut taken = Vec::new();
        let admitted = admit_each(staging_root, paths, &mut granted, &mut taken);
        if admitted.is_err() {
            tracing::warn!(
                scope = "import",
                "an import named a file that was neither dropped nor picked; refused"
            );
            granted.extend(taken);
        }
        admitted
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PathBuf>> {
        self.granted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// [`ImportGrants::admit`] with the dialog's answer held; every pick it takes joins `taken`.
fn admit_each(
    staging_root: &Path,
    paths: &[String],
    granted: &mut HashMap<String, PathBuf>,
    taken: &mut Vec<(String, PathBuf)>,
) -> Result<Vec<ImportSource>, SourceRefused> {
    let mut claims = Vec::with_capacity(paths.len());
    for path in paths {
        if staged_as_spelled(staging_root, Path::new(path)) {
            claims.push(Claim::Staged);
        } else if let Some(real) = granted.remove(path) {
            taken.push((path.clone(), real.clone()));
            claims.push(Claim::Picked(real));
        } else {
            return Err(SourceRefused::NotAllowed);
        }
    }
    let root = staging_root.canonicalize().ok();
    let mut sources = Vec::with_capacity(paths.len());
    for (path, claim) in paths.iter().zip(claims) {
        let path = Path::new(path);
        let resolved = path.canonicalize();
        if let Ok(real) = &resolved {
            let held = match &claim {
                Claim::Staged => root.as_deref().is_some_and(|root| real.starts_with(root)),
                Claim::Picked(picked) => real == picked,
            };
            if !held {
                return Err(SourceRefused::NotAllowed);
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
    Ok(sources)
}

/// Whether `path`, as spelled, names something below the absolute `root` through plain names
/// only.
fn staged_as_spelled(root: &Path, path: &Path) -> bool {
    root.is_absolute()
        && path.strip_prefix(root).is_ok_and(|rest| {
            let mut parts = rest.components().peekable();
            parts.peek().is_some() && parts.all(|part| matches!(part, Component::Normal(_)))
        })
}

//! The open sequence, in the stage order of `vault/index.ts:613-968`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::storage::OpenOptions;
use memry_core::storage::recovery_prune::prune_settled;

use super::projection::{DEFAULT_QUEUE_LIMIT, ProjectionRuntime};
use super::{
    Open, OpenSource, OpenStage, OpenVault, Session, SessionError, SessionEvent, SessionStatus,
    VaultOpened, lock,
};
use crate::registry::vaults::basename;
use crate::vault::config::{invalidate_vault_config_cache, read_vault_config};
use crate::vault::init::{CountLimits, count_markdown_files, init_vault, is_vault_initialized};
use crate::vault::move_journal::sweep as sweep_moves;

/// Settled `data.db.corrupt-*` quarantines kept. Core decides which are settled
/// ([`prune_settled`]); this only says how many of those to keep.
const KEEP_SETTLED_QUARANTINES: usize = 2;

/// `<vault>/.memry/core`: where the core databases live. The Electron `.memry/data.db` and
/// `index.db` beside it are never opened.
pub(super) fn core_dir(vault: &Path) -> PathBuf {
    vault.join(".memry").join("core")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `initVault` for a folder with no `.memry` yet, then `.memry/core/` (mode 0700 on Unix),
/// which proves the folder is writable. The init comes first: afterwards `.memry` exists and
/// the folder would read as initialised.
fn prepare_core_dir(path: &Path) -> Result<PathBuf, SessionError> {
    if !path.is_dir() {
        return Err(SessionError::Invalid(
            "Selected path is not a valid directory".into(),
        ));
    }
    if !is_vault_initialized(path) {
        init_vault(path).map_err(|err| match err.kind() {
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem => {
                SessionError::Invalid(format!("No write permission for selected directory: {err}"))
            }
            _ => SessionError::Storage(StorageError::Failed {
                what: format!("could not initialise the vault: {err}"),
            }),
        })?;
    }
    let core = core_dir(path);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&core).map_err(|err| match err.kind() {
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem => {
            SessionError::Invalid(format!("No write permission for selected directory: {err}"))
        }
        // Anything else (a share that went away, an I/O error) may pass; not the vault's fault.
        _ => SessionError::Storage(StorageError::Failed {
            what: format!("could not create {}: {err}", core.display()),
        }),
    })?;
    Ok(core)
}

impl Session {
    pub(super) fn open_locked(
        &self,
        path: &Path,
        source: OpenSource,
    ) -> Result<VaultOpened, SessionError> {
        if lock(&self.inner.state).open.is_some() {
            return Err(SessionError::AlreadyOpen);
        }
        self.ensure_not_held(path)?;
        let started = Instant::now();
        // Start from disk, never from what the previously open vault left in the cache.
        invalidate_vault_config_cache();
        let core = prepare_core_dir(path)?;
        let path_text = path.to_string_lossy().into_owned();

        let data_db = core.join("data.db");
        let vault = Vault::open_with(
            core.to_string_lossy().into_owned(),
            OpenOptions {
                verify_integrity: true,
            },
        )
        .map_err(|error| match error {
            StorageError::Corrupt { .. } => SessionError::Corrupt {
                path: data_db.to_string_lossy().into_owned(),
            },
            other => SessionError::Storage(other),
        })?;
        let (search, index_reason) = vault.search_reporting()?;
        if let Some(reason) = &index_reason {
            self.emit(SessionEvent::IndexRecovered {
                reason: reason.clone(),
            });
        }
        tracing::info!(elapsed = ?started.elapsed(), "vault core stages done");

        match prune_settled(&data_db, KEEP_SETTLED_QUARANTINES) {
            Ok(0) => {}
            Ok(removed) => tracing::info!(removed, "pruned settled data.db quarantines"),
            Err(error) => tracing::warn!(%error, "could not prune data.db quarantines"),
        }

        let exclude = read_vault_config(path).exclude_patterns;
        // Before any open hook, so before the watcher: a folder move a crash interrupted is put
        // back or shown, and its notes are never reported removed.
        let swept = sweep_moves(path, &exclude);
        if swept.undone > 0 || swept.left_beside() {
            tracing::warn!(
                undone = swept.undone,
                conflict_copies = swept.conflict_copies.len(),
                kept = swept.kept.len(),
                "swept interrupted folder moves"
            );
        }
        if swept.left_beside() {
            self.emit(SessionEvent::Error {
                message: "A folder move was interrupted and undone, but not every note went back \
                          under its own name: look for notes ending in \"(conflict copy)\" and \
                          folders ending in \"(incomplete move)\". Nothing was deleted."
                    .to_owned(),
            });
        }
        let note_count = count_markdown_files(path, &exclude, CountLimits::DEFAULT).count;
        let stored = match self
            .inner
            .registry
            .record_open(&path_text, now_ms(), note_count)
        {
            Ok(stored) => Some(stored),
            Err(error) => {
                tracing::error!(%error, "the vault registry was not updated");
                self.emit(SessionEvent::Error {
                    message: format!("The vault list could not be saved: {error}"),
                });
                None
            }
        };

        let view = OpenVault {
            path: path.to_path_buf(),
            vault_id: vault.id(),
            name: stored
                .as_ref()
                .map_or_else(|| basename(&path_text), |s| s.name.clone()),
            vault: Arc::new(vault),
            search,
        };
        let projectors = lock(&self.inner.projectors).clone();
        let runtime = Arc::new(
            ProjectionRuntime::start(projectors, DEFAULT_QUEUE_LIMIT).map_err(|err| {
                SessionError::Storage(StorageError::Failed {
                    what: format!("could not start the projection lanes: {err}"),
                })
            })?,
        );

        self.run_open_hooks(&view, |stage| stage.before_open());
        {
            let mut state = lock(&self.inner.state);
            state.error = None;
            state.open = Some(Open {
                view: view.clone(),
                runtime: runtime.clone(),
                background: Vec::new(),
            });
        }
        self.emit(SessionEvent::StatusChanged(SessionStatus {
            is_open: true,
            path: Some(path_text.clone()),
            error: None,
        }));
        self.emit(SessionEvent::Opened {
            path: path_text,
            source,
        });
        self.emit(SessionEvent::ListChanged);

        self.run_open_hooks(&view, |stage| !stage.before_open());
        let session = self.clone();
        let chained = runtime.start_reconcile(Arc::new(move |projector, error| {
            session.emit(SessionEvent::ProjectionReconcileFailed {
                projector: projector.to_owned(),
                error: error.to_owned(),
            });
        }));
        if let Err(error) = chained {
            tracing::error!(%error, "could not start the reconcile chain");
        }
        self.spawn_background_hooks(&view, &runtime);
        tracing::info!(elapsed = ?started.elapsed(), "vault open");
        Ok(VaultOpened {
            vault: view,
            stored,
            index_recovered: index_reason,
        })
    }

    /// Runs the hooks of the stages `select` accepts, in stage order then registration
    /// order. A failing hook is logged by name and never closes the vault.
    fn run_open_hooks(&self, view: &OpenVault, select: impl Fn(OpenStage) -> bool) {
        let mut hooks: Vec<_> = lock(&self.inner.hooks)
            .open
            .iter()
            .filter(|(_, stage, _)| select(*stage))
            .cloned()
            .collect();
        hooks.sort_by_key(|(_, stage, _)| *stage);
        for (name, stage, hook) in hooks {
            let started = Instant::now();
            if let Err(error) = hook(view) {
                tracing::error!(hook = %name, ?stage, %error, "open hook failed");
            }
            tracing::info!(hook = %name, ?stage, elapsed = ?started.elapsed(), "open hook done");
        }
    }

    /// The background tasks: spawned, never awaited, cancelled and joined by close. A task
    /// that cannot be spawned is logged; the vault stays open without it.
    fn spawn_background_hooks(&self, view: &OpenVault, runtime: &ProjectionRuntime) {
        let hooks = lock(&self.inner.hooks).background.clone();
        let mut handles = Vec::new();
        for (name, hook) in hooks {
            let (view, cancel, task) = (view.clone(), runtime.cancel_token(), name.clone());
            let spawned = std::thread::Builder::new()
                .name(format!("open-{name}"))
                .spawn(move || {
                    if let Err(error) = hook(&view, &cancel) {
                        tracing::error!(task = %task, %error, "background open hook failed");
                    }
                });
            match spawned {
                Ok(handle) => handles.push((name, handle)),
                Err(error) => {
                    tracing::error!(task = %name, %error, "could not start a background task")
                }
            }
        }
        if let Some(open) = lock(&self.inner.state).open.as_mut() {
            open.background = handles;
        }
    }
}

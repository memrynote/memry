//! The open sequence, in the stage order of `vault/index.ts:613-968`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::storage::OpenOptions;
use memry_core::storage::recovery_prune::prune_settled;
use sha2::{Digest, Sha256};

use super::projection::{DEFAULT_QUEUE_LIMIT, ProjectionRuntime};
use super::{
    Open, OpenSource, OpenStage, OpenVault, Session, SessionError, SessionEvent, SessionStatus,
    VaultOpened, lock,
};
use crate::registry::vaults::basename;

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

/// Creates `.memry/core/` (mode 0700 on Unix) and proves the folder is writable by that.
fn prepare_core_dir(path: &Path) -> Result<PathBuf, SessionError> {
    if !path.is_dir() {
        return Err(SessionError::Invalid(
            "Selected path is not a valid directory".into(),
        ));
    }
    let core = core_dir(path);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&core).map_err(|err| {
        SessionError::Invalid(format!("No write permission for selected directory: {err}"))
    })?;
    Ok(core)
}

/// The label core records for the vault. The server vault uuid replaces it once sync stamps
/// one (Step 17); until then it is derived from the path, so it does not change between
/// launches. Only a label in this process: nothing persists it.
fn vault_id(uuid: Option<String>, path: &Path) -> String {
    uuid.unwrap_or_else(|| {
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let digest = Sha256::digest(resolved.to_string_lossy().as_bytes());
        format!("local:{}", &hex::encode(digest)[..32])
    })
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
        let core = prepare_core_dir(path)?;
        let path_text = path.to_string_lossy().into_owned();
        let id = vault_id(
            self.inner
                .registry
                .get(&path_text)
                .and_then(|s| s.vault_uuid),
            path,
        );

        let data_db = core.join("data.db");
        let vault = Vault::open_with(
            id.clone(),
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

        let stored = match self.inner.registry.record_open(&path_text, now_ms()) {
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
            vault_id: id,
            name: stored
                .as_ref()
                .map_or_else(|| basename(&path_text), |s| s.name.clone()),
            vault: Arc::new(vault),
            search,
        };
        let projectors = lock(&self.inner.projectors).clone();
        let runtime = Arc::new(ProjectionRuntime::start(projectors, DEFAULT_QUEUE_LIMIT));

        self.run_open_hooks(&view, |stage| stage.before_open());
        {
            let mut state = lock(&self.inner.state);
            state.error = None;
            state.open = Some(Open {
                view: view.clone(),
                runtime: runtime.clone(),
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

        self.run_open_hooks(&view, |stage| {
            !stage.before_open() && stage != OpenStage::BackgroundIndex
        });
        let session = self.clone();
        runtime.start_reconcile(Arc::new(move |projector, error| {
            session.emit(SessionEvent::ProjectionReconcileFailed {
                projector: projector.to_owned(),
                error: error.to_owned(),
            });
        }));
        self.spawn_background_hooks(&view);
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

    /// The background index build: spawned, never awaited.
    fn spawn_background_hooks(&self, view: &OpenVault) {
        let hooks: Vec<_> = lock(&self.inner.hooks)
            .open
            .iter()
            .filter(|(_, stage, _)| *stage == OpenStage::BackgroundIndex)
            .cloned()
            .collect();
        for (name, _, hook) in hooks {
            let view = view.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("open-{name}"))
                .spawn(move || {
                    if let Err(error) = hook(&view) {
                        tracing::error!(hook = %name, %error, "background open hook failed");
                    }
                });
            if let Err(error) = spawned {
                tracing::error!(%error, "could not start a background open hook");
            }
        }
    }
}

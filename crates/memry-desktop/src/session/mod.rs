//! `Session`: the one owner of the open vault.
//!
//! A vault is opened, switched and closed here and nowhere else. The session holds the vault's
//! core databases (`<vault>/.memry/core/data.db` and `index.db`), the projection runtime, and
//! the hooks later steps register; the registry in `memry-config.json` is told what was
//! opened. Every operation runs through one lifecycle queue, a port of
//! `runVaultLifecycleOperation`: an operation starts only after the previous one finished, and
//! a failed one does not poison the queue.
//!
//! **The recovery invariant lives in core.** `data.db` is opened with `verify_integrity`. A
//! damaged file comes back as [`SessionError::Corrupt`] with the file untouched; the session
//! never quarantines on its own. Only [`Session::repair`], which the shell calls after the
//! user agreed, does, and it re-checks first (the file may be fine by then) and refuses while
//! any handle to the old vault could still be alive. A transient error (busy, I/O) is an
//! error, never a reason to move a database aside.
//!
//! The session is synchronous: its methods block and the Tauri adapters call them from
//! `spawn_blocking`.

mod hooks;
mod open;
pub mod projection;
pub mod prompt;
pub mod response;
mod startup;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::storage::recovery::RecoveryReport;

pub use hooks::{BackgroundHook, CloseHook, OpenHook, OpenStage};
use hooks::{Hooks, run_with_deadline};
use projection::{ProjectionRuntime, Projector};
pub use startup::{FORCE_VAULT_PICKER_VAR, StartupVault, resolve_startup_vault};

use crate::error::{CoreError, FailureKind};
use crate::registry::create::{CreateError, create_vault_folder};
use crate::registry::vault_icon::{self, IconError};
use crate::registry::{GetVaultsResponse, RegistryError, SandboxInfo, StoredVault, VaultRegistry};

/// The Electron projection drain default, per hook.
pub const HOOK_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// The folder cannot hold a vault: not a directory, or not writable.
    #[error("{0}")]
    Invalid(String),
    /// `data.db` is damaged, or an earlier recovery never finished. Nothing was changed; the
    /// shell asks the user and calls [`Session::repair`].
    #[error("the vault database is damaged: {path}")]
    Corrupt { path: String },
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Registry(#[from] RegistryError),
    #[error("A vault switch is already in progress")]
    SwitchInProgress,
    #[error("a vault is already open; close or switch it first")]
    AlreadyOpen,
    /// A thread of the previous session (a close hook past its deadline, a projection lane)
    /// may still hold this vault's databases. Reopening or repairing it now would race it.
    #[error("the vault at {0} is still held by a thread that did not stop; restart the app")]
    Held(String),
}

impl CoreError for SessionError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Invalid(_) => (FailureKind::Invalid, "invalid_vault"),
            Self::Corrupt { .. } => (FailureKind::Recovery, "storage_corrupt"),
            Self::Storage(error) => error.kind_and_code(),
            Self::Registry(_) => (FailureKind::Storage, "registry_failed"),
            Self::SwitchInProgress => (FailureKind::Invalid, "switch_in_progress"),
            Self::AlreadyOpen => (FailureKind::Invalid, "vault_already_open"),
            Self::Held(_) => (FailureKind::Locked, "vault_held"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStatus {
    pub is_open: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// Why a vault was opened. Step 09 turns `Select`/`Create` into `vault_opened` and
/// `vault_created`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenSource {
    Startup,
    Select,
    Switch,
    Create,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    StatusChanged(SessionStatus),
    Error {
        message: String,
    },
    /// `index.db` was missing, damaged or newer than this build and was rebuilt empty: the
    /// index content is owed a rebuild from the vault files (Step 12).
    IndexRecovered {
        reason: String,
    },
    ListChanged,
    Opened {
        path: String,
        source: OpenSource,
    },
    Created {
        path: String,
    },
    /// A projector's reconcile pass failed (`track_main_warning("projection", "reconcile")`).
    ProjectionReconcileFailed {
        projector: String,
        error: String,
    },
}

/// The open vault, as hooks and commands see it. Cheap to clone.
#[derive(Clone)]
pub struct OpenVault {
    pub path: PathBuf,
    pub vault_id: String,
    pub name: String,
    pub vault: Arc<Vault>,
    pub search: Arc<Search>,
}

/// What [`Session::open_startup`] did. `Failed` carries the error so the shell can offer
/// recovery for [`SessionError::Corrupt`]; the picker shows either way.
pub enum StartupOutcome {
    Opened(VaultOpened),
    Picker,
    Failed { path: PathBuf, error: SessionError },
}

pub struct VaultOpened {
    pub vault: OpenVault,
    /// The registry entry after the open, when it could be written.
    pub stored: Option<StoredVault>,
    pub index_recovered: Option<String>,
}

#[derive(Debug)]
pub enum RepairOutcome {
    /// The database opened and passed its integrity check: nothing was moved.
    NotCorrupt,
    Rebuilt(RecoveryReport),
}

struct Open {
    view: OpenVault,
    runtime: Arc<ProjectionRuntime>,
    background: Vec<(String, JoinHandle<()>)>,
}

#[derive(Default)]
struct State {
    open: Option<Open>,
    error: Option<String>,
}

/// A vault that was open: weak handles to what a stuck thread could still be holding.
type Held = (Weak<Vault>, Weak<Search>);

struct Inner {
    registry: VaultRegistry,
    lifecycle: Mutex<()>,
    switching: AtomicBool,
    shutdown: AtomicBool,
    state: Mutex<State>,
    hooks: Mutex<Hooks>,
    projectors: Mutex<Vec<Arc<dyn Projector>>>,
    subscribers: Mutex<Vec<Sender<SessionEvent>>>,
    /// Every vault that was open, by canonical path, to tell whether a stuck thread still
    /// holds one (invariant: no two live handles for one vault path).
    held: Mutex<HashMap<PathBuf, Held>>,
    hook_deadline: Duration,
}

#[derive(Clone)]
pub struct Session {
    inner: Arc<Inner>,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic in a hook or a closure must not wedge the lifecycle for good.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Clears the switching flag however the switch ends.
struct SwitchGuard<'a>(&'a AtomicBool);

impl Drop for SwitchGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Session {
    pub fn new(registry: VaultRegistry) -> Self {
        Self::with_hook_deadline(registry, HOOK_DEADLINE)
    }

    pub fn with_hook_deadline(registry: VaultRegistry, hook_deadline: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                registry,
                lifecycle: Mutex::new(()),
                switching: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
                state: Mutex::new(State::default()),
                hooks: Mutex::new(Hooks::new()),
                projectors: Mutex::new(Vec::new()),
                subscribers: Mutex::new(Vec::new()),
                held: Mutex::new(HashMap::new()),
                hook_deadline,
            }),
        }
    }

    pub fn registry(&self) -> &VaultRegistry {
        &self.inner.registry
    }

    /// Events from now on. A receiver that is dropped is forgotten at the next event.
    pub fn subscribe(&self) -> Receiver<SessionEvent> {
        let (tx, rx) = channel();
        lock(&self.inner.subscribers).push(tx);
        rx
    }

    pub fn status(&self) -> SessionStatus {
        let state = lock(&self.inner.state);
        SessionStatus {
            is_open: state.open.is_some(),
            path: state
                .open
                .as_ref()
                .map(|o| o.view.path.to_string_lossy().into_owned()),
            error: state.error.clone(),
        }
    }

    pub fn current(&self) -> Option<OpenVault> {
        lock(&self.inner.state)
            .open
            .as_ref()
            .map(|o| o.view.clone())
    }

    /// The projection runtime of the open vault, for publishers.
    pub fn projections(&self) -> Option<Arc<ProjectionRuntime>> {
        lock(&self.inner.state)
            .open
            .as_ref()
            .map(|o| o.runtime.clone())
    }

    pub fn is_switching(&self) -> bool {
        self.inner.switching.load(Ordering::SeqCst)
    }

    /// From here on no status or list event reaches a subscriber (the app is quitting).
    pub fn begin_shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
    }

    /// A hook that runs after the core stages of every open, in `stage` order.
    pub fn on_open(&self, name: &str, stage: OpenStage, hook: OpenHook) {
        lock(&self.inner.hooks)
            .open
            .push((name.to_owned(), stage, hook));
    }

    /// A background task of the open vault (the index build). Spawned after the open and never
    /// awaited; close cancels the token it is given and joins the thread.
    pub fn on_background(&self, name: &str, hook: BackgroundHook) {
        lock(&self.inner.hooks)
            .background
            .push((name.to_owned(), hook));
    }

    /// A hook that runs on every close, in reverse registration order, each with a deadline.
    /// The `Vault` is dropped only after all of them returned or overran.
    pub fn on_close(&self, name: &str, hook: CloseHook) {
        lock(&self.inner.hooks).close.push((name.to_owned(), hook));
    }

    /// Registered before a vault opens; each open starts a lane for it.
    pub fn register_projector(&self, projector: Arc<dyn Projector>) {
        lock(&self.inner.projectors).push(projector);
    }

    pub fn open(&self, path: &Path, source: OpenSource) -> Result<VaultOpened, SessionError> {
        let _queue = lock(&self.inner.lifecycle);
        let outcome = self.open_locked(path, source);
        self.report_failure(&outcome);
        outcome
    }

    pub fn close(&self) {
        let _queue = lock(&self.inner.lifecycle);
        self.close_locked(true);
    }

    /// Closes the open vault (if any) and opens `path`. Waits behind a running operation.
    pub fn replace(&self, path: &Path, source: OpenSource) -> Result<VaultOpened, SessionError> {
        let _queue = lock(&self.inner.lifecycle);
        self.replace_locked(path, source)
    }

    /// [`Session::replace`] that is refused, not queued, while another switch runs
    /// (`vault/index.ts:1310`). No transient `is_open: false` is emitted; one status with the
    /// error is emitted when the switch leaves no vault open.
    pub fn switch(&self, path: &Path) -> Result<VaultOpened, SessionError> {
        if self
            .inner
            .switching
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(SessionError::SwitchInProgress);
        }
        let _flag = SwitchGuard(&self.inner.switching);
        let _queue = lock(&self.inner.lifecycle);
        self.replace_locked(path, OpenSource::Switch)
    }

    /// Creates `<parent>/<name>` and opens it.
    pub fn create(&self, parent: &Path, name: &str) -> Result<VaultOpened, CreateOrOpenError> {
        let target = create_vault_folder(parent, name)?;
        let opened = self.replace(&target, OpenSource::Create)?;
        self.emit(SessionEvent::Created {
            path: target.to_string_lossy().into_owned(),
        });
        Ok(opened)
    }

    /// Forgets the vault in the registry, closing it first when it is the open one. Never
    /// touches the folder.
    pub fn remove(&self, path: &str) -> Result<(), SessionError> {
        let _queue = lock(&self.inner.lifecycle);
        if self.status().path.as_deref() == Some(path) {
            self.close_locked(true);
        }
        self.inner.registry.remove(path)?;
        self.emit(SessionEvent::ListChanged);
        Ok(())
    }

    pub fn set_default(&self, path: &str) -> Result<(), SessionError> {
        self.inner.registry.set_default(path)?;
        self.emit(SessionEvent::ListChanged);
        Ok(())
    }

    pub fn list(&self, sandbox: SandboxInfo) -> GetVaultsResponse {
        self.inner.registry.list(sandbox)
    }

    /// Sets or resets a vault's icon and tells subscribers the list changed.
    pub fn set_icon(&self, path: &str, icon: Option<&str>, now_ms: i64) -> Result<(), IconError> {
        vault_icon::set(&self.inner.registry, path, icon, now_ms)?;
        self.emit(SessionEvent::ListChanged);
        Ok(())
    }

    /// Opens the vault the registry names for launch, as [`resolve_startup_vault`] decides.
    /// A vault that fails to open leaves the app on the picker: the failure is logged and in
    /// the status, and `currentVault` is cleared unless the database is damaged (then the
    /// next launch offers recovery again).
    pub fn open_startup(&self, env: &crate::launch_env::LaunchEnv) -> StartupOutcome {
        let StartupVault::Open(path) = resolve_startup_vault(self.inner.registry.config(), env)
        else {
            return StartupOutcome::Picker;
        };
        match self.open(&path, OpenSource::Startup) {
            Ok(opened) => StartupOutcome::Opened(opened),
            Err(error) => {
                tracing::error!(path = %path.display(), %error, "the last vault did not open");
                // Only a vault that cannot be opened at all stops being the current one. A
                // damaged database (recovery is offered again), a busy or unreadable one, or
                // a stuck holder is not the vault's fault, and forgetting it would hide it.
                let permanent = matches!(
                    error,
                    SessionError::Invalid(_)
                        | SessionError::Storage(StorageError::ForeignSchema { .. })
                );
                if permanent && let Err(error) = self.inner.registry.clear_current() {
                    tracing::error!(%error, "could not clear currentVault");
                }
                StartupOutcome::Failed { path, error }
            }
        }
    }

    fn replace_locked(&self, path: &Path, source: OpenSource) -> Result<VaultOpened, SessionError> {
        // `validateVaultPath` runs before the close in Electron too: a folder that is gone (a
        // typo, an unmounted drive) must not take the vault the user is working in with it.
        if !path.is_dir() {
            let outcome = Err(SessionError::Invalid(
                "Selected path is not a valid directory".into(),
            ));
            self.report_failure(&outcome);
            return outcome;
        }
        self.close_locked(false);
        let outcome = self.open_locked(path, source);
        self.report_failure(&outcome);
        outcome
    }

    /// A failed open leaves no vault open. Subscribers hear it once, in a status with the
    /// reason.
    fn report_failure<T>(&self, outcome: &Result<T, SessionError>) {
        if let Err(error) = outcome
            && !matches!(error, SessionError::AlreadyOpen)
        {
            let status = {
                let mut state = lock(&self.inner.state);
                state.error = Some(error.to_string());
                SessionStatus {
                    is_open: state.open.is_some(),
                    path: state
                        .open
                        .as_ref()
                        .map(|o| o.view.path.to_string_lossy().into_owned()),
                    error: state.error.clone(),
                }
            };
            self.emit(SessionEvent::StatusChanged(status));
        }
    }

    /// The user agreed to repair a damaged `data.db` of the vault at `vault_path`. Under the
    /// lifecycle queue: refuses while that vault is open or a stuck thread may hold it,
    /// re-runs the verified open (the file may be fine now, and then nothing moves), and only
    /// if it still reports damage quarantines and rebuilds. The caller reopens afterwards.
    pub fn repair(&self, vault_path: &Path) -> Result<RepairOutcome, SessionError> {
        let _queue = lock(&self.inner.lifecycle);
        let open_here = self
            .current()
            .is_some_and(|open| canonical(&open.path) == canonical(vault_path));
        if open_here {
            return Err(SessionError::Held(vault_path.display().to_string()));
        }
        self.ensure_not_held(vault_path)?;
        let data_db = open::core_dir(vault_path).join("data.db");
        let verified = memry_core::storage::OpenOptions {
            verify_integrity: true,
        };
        match memry_core::storage::open_data_with(&data_db, verified) {
            Ok(db) => {
                drop(db);
                Ok(RepairOutcome::NotCorrupt)
            }
            Err(StorageError::Corrupt { .. }) => {
                let report = memry_core::storage::recovery::quarantine_and_rebuild(&data_db)?;
                if let Some(problems) = report.problems() {
                    tracing::warn!(quarantined = %report.quarantined.display(), %problems, "recovery was partial");
                } else {
                    tracing::info!(quarantined = %report.quarantined.display(), "data.db recovered");
                }
                Ok(RepairOutcome::Rebuilt(report))
            }
            Err(other) => Err(other.into()),
        }
    }

    /// Refuses while a thread that outlived an earlier close of this vault still holds its
    /// databases. Retries for up to one hook deadline first: the thread is usually on its way
    /// out, and an immediate error would turn a slow close into a failed switch.
    fn ensure_not_held(&self, path: &Path) -> Result<(), SessionError> {
        let key = canonical(path);
        let end = Instant::now() + self.inner.hook_deadline;
        loop {
            let mut held = lock(&self.inner.held);
            held.retain(|_, (vault, search)| vault.strong_count() > 0 || search.strong_count() > 0);
            if !held.contains_key(&key) {
                return Ok(());
            }
            drop(held);
            if Instant::now() >= end {
                return Err(SessionError::Held(path.display().to_string()));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn emit(&self, event: SessionEvent) {
        let quiet = matches!(
            event,
            SessionEvent::StatusChanged(_) | SessionEvent::ListChanged
        );
        if quiet && self.inner.shutdown.load(Ordering::SeqCst) {
            return;
        }
        lock(&self.inner.subscribers).retain(|tx| tx.send(event.clone()).is_ok());
    }

    fn close_locked(&self, emit_status: bool) {
        let Some(open) = lock(&self.inner.state).open.take() else {
            return;
        };
        // A reconcile pass reads the vault, so it stops before anything else closes.
        open.runtime.cancel_token().cancel();
        let hooks: Vec<_> = lock(&self.inner.hooks)
            .close
            .iter()
            .rev()
            .cloned()
            .collect();
        for (name, hook) in hooks {
            let view = open.view.clone();
            run_with_deadline(&name, self.inner.hook_deadline, move || hook(&view));
        }
        let report = open.runtime.stop(true);
        if !report.stuck.is_empty() {
            tracing::warn!(stuck = ?report.stuck, "the vault stays held by projection threads");
        }
        // Background tasks were told to stop with the runtime's token; give them the same
        // deadline as a close hook. One that overruns keeps its clone of the vault, which
        // `ensure_not_held` sees.
        let end = Instant::now() + self.inner.hook_deadline;
        for (name, handle) in open.background {
            while !handle.is_finished() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(5));
            }
            if handle.is_finished() {
                let _ = handle.join();
            } else {
                tracing::warn!(task = %name, "a background task did not stop before the deadline");
            }
        }
        lock(&self.inner.held).insert(
            canonical(&open.view.path),
            (
                Arc::downgrade(&open.view.vault),
                Arc::downgrade(&open.view.search),
            ),
        );
        drop(open.view);
        drop(open.runtime);
        lock(&self.inner.state).error = None;
        if emit_status {
            self.emit(SessionEvent::StatusChanged(SessionStatus {
                is_open: false,
                path: None,
                error: None,
            }));
        }
    }
}

/// The path as the file system names it, so two spellings of one folder (a symlink, a
/// different case on a case-insensitive volume) are one key.
pub(crate) fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// [`Session::create`] fails either creating the folder or opening it.
#[derive(Debug, thiserror::Error)]
pub enum CreateOrOpenError {
    #[error(transparent)]
    Create(#[from] CreateError),
    #[error(transparent)]
    Open(#[from] SessionError),
}

#[cfg(test)]
mod fixture;
#[cfg(test)]
mod identity;
#[cfg(test)]
mod lifecycle;
#[cfg(test)]
mod recovery;
#[cfg(test)]
mod switch;

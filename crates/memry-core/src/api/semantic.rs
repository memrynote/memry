//! On-device semantic search (#4505): the one device-scoped object the shell
//! builds. It owns the opt-in, the model download and the model slot.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::api::errors::StorageError;
use crate::api::vault::Vault;
use crate::domain::embedding_input::query_input;
use crate::domain::search::semantic::{SemanticHit, nearest, wants_semantic};
use crate::seams::reachability::{Reachability, Reachable};
use crate::seams::transport::Transport;
use crate::semantic::download::{self, DownloadEnd, DownloadError};
use crate::semantic::queue::InFlight;
use crate::semantic::{Loader, ModelDir, ModelHost, SemanticError, load};
use crate::storage::Db;
use crate::storage::vector_db::{self, VectorStore};

/// Left free after the download, so the model never fills the disk.
const SPACE_HEADROOM_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum DownloadFailure {
    /// A finished file's sha256 differed from the pin. The part is deleted, so
    /// the next attempt starts that file over.
    Mismatch,
    /// The host answered with something other than the range asked for.
    Http {
        status: u16,
    },
    Network,
    /// Writing the model files failed, most often because the disk is full.
    Storage,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ModelState {
    Off,
    Downloading {
        received: u64,
        total: u64,
    },
    /// Wi-Fi means unmetered: a hotspot or Low Data Mode counts as cellular.
    WaitingForWifi {
        received: u64,
        total: u64,
    },
    Failed {
        received: u64,
        total: u64,
        failure: DownloadFailure,
    },
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SemanticStatus {
    pub model: ModelState,
    pub download_bytes: u64,
    pub embedded_notes: u32,
    pub total_notes: u32,
}

/// The last download attempt's outcome, in memory only. A relaunch starts
/// `Idle`, and the shell's `resume` picks the download up again.
enum Transfer {
    Idle,
    Running,
    WaitingForWifi,
    Failed(DownloadFailure),
}

#[derive(uniffi::Object)]
pub struct SemanticSearch {
    model: ModelDir,
    host: ModelHost,
    transport: Arc<dyn Transport>,
    reachability: Arc<dyn Reachability>,
    transfer: Mutex<Transfer>,
    /// One download at a time.
    download: tokio::sync::Mutex<()>,
    /// One `vectors.db` handle per vault directory.
    vectors: Mutex<HashMap<PathBuf, Db>>,
    /// One embed step at a time.
    step: tokio::sync::Mutex<()>,
    /// The note each vault's embedder is part way through, by vault directory.
    in_flight: Mutex<HashMap<PathBuf, InFlight>>,
    /// Source keys whose inference failed this process (queue invariant 5).
    skipped: Mutex<HashSet<[u8; 32]>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[uniffi::export(async_runtime = "tokio")]
impl SemanticSearch {
    /// No model load and no network. Build exactly one per process.
    #[uniffi::constructor]
    pub fn new(
        models_dir: String,
        transport: Arc<dyn Transport>,
        reachability: Arc<dyn Reachability>,
    ) -> Arc<Self> {
        Arc::new(Self::over(
            ModelDir::new(PathBuf::from(models_dir)),
            transport,
            reachability,
        ))
    }

    /// Cheap: file sizes and two counts.
    pub fn status(&self, vault: Arc<Vault>) -> SemanticStatus {
        let total_notes = vault
            .db_handle()
            .call_blocking(|conn| live_note_count(conn))
            .unwrap_or_else(|error| {
                eprintln!("memry-core: semantic status could not count notes: {error}");
                0
            });
        let embedded_notes = if self.model.opted_in() {
            self.embedded_notes(vault.directory())
                .unwrap_or_else(|error| {
                    eprintln!("memry-core: semantic status could not read vectors.db: {error}");
                    0
                })
        } else {
            0
        };
        SemanticStatus {
            model: self.model_state(),
            download_bytes: self.model.manifest().total_bytes(),
            embedded_notes,
            total_notes,
        }
    }

    /// Opts this device in, then downloads or resumes. Refuses when the rest
    /// of the download would leave less than 64 MiB free. Idempotent.
    pub async fn enable(&self, available_bytes: u64) -> Result<ModelState, SemanticError> {
        let missing = self.model.missing_bytes();
        let needed_bytes = missing + SPACE_HEADROOM_BYTES;
        if missing > 0 && available_bytes < needed_bytes {
            return Err(StorageError::OutOfSpace {
                needed_bytes,
                available_bytes,
            }
            .into());
        }
        self.model.set_opted_in().map_err(io_failed)?;
        self.run_download().await
    }

    /// Downloads or resumes only when this device opted in. For foregrounding
    /// and Wi-Fi coming back.
    pub async fn resume(&self) -> Result<ModelState, SemanticError> {
        if !self.model.opted_in() {
            return Ok(ModelState::Off);
        }
        self.run_download().await
    }

    /// Unloads the model, deletes the model files and the opt-in, and deletes
    /// this vault's `vectors.db`. Other vaults delete theirs on their next
    /// open, because the opt-in is gone.
    pub async fn disable(&self, vault: Arc<Vault>) -> Result<(), SemanticError> {
        // The first pass removes the opt-in, which stops a download in flight
        // at its next range; the second removes what that range wrote.
        self.model.clear().map_err(io_failed)?;
        let _download = self.download.lock().await;
        // A step in flight holds a `vectors.db` handle; the delete waits for it.
        let _step = self.step.lock().await;
        self.model.clear().map_err(io_failed)?;
        *lock(&self.transfer) = Transfer::Idle;
        self.host.unload();
        lock(&self.in_flight).clear();
        // Held across the delete, so a status poll cannot reopen the file.
        let mut handles = lock(&self.vectors);
        handles.clear();
        vector_db::open(&vault.directory().join("vectors.db"), false)?;
        Ok(())
    }
}

impl SemanticSearch {
    pub(crate) fn over(
        model: ModelDir,
        transport: Arc<dyn Transport>,
        reachability: Arc<dyn Reachability>,
    ) -> Self {
        let models = model.clone();
        let loader: Loader = Arc::new(move |threads| {
            let verified = models
                .verified()
                .filter(|_| models.opted_in())
                .ok_or_else(|| SemanticError::inference("the model is not downloaded"))?;
            load(&verified, threads)
        });
        Self::with_loader(model, transport, reachability, loader)
    }

    pub(crate) fn with_loader(
        model: ModelDir,
        transport: Arc<dyn Transport>,
        reachability: Arc<dyn Reachability>,
        loader: Loader,
    ) -> Self {
        Self {
            model,
            host: ModelHost::new(loader),
            transport,
            reachability,
            transfer: Mutex::new(Transfer::Idle),
            download: tokio::sync::Mutex::new(()),
            vectors: Mutex::new(HashMap::new()),
            step: tokio::sync::Mutex::new(()),
            in_flight: Mutex::new(HashMap::new()),
            skipped: Mutex::new(HashSet::new()),
        }
    }

    fn model_state(&self) -> ModelState {
        if !self.model.opted_in() {
            return ModelState::Off;
        }
        if self.model.verified().is_some() {
            return ModelState::Ready;
        }
        let (received, total) = (
            self.model.received_bytes(),
            self.model.manifest().total_bytes(),
        );
        match &*lock(&self.transfer) {
            Transfer::Idle if self.reachability.current() != Reachable::Wifi => {
                ModelState::WaitingForWifi { received, total }
            }
            Transfer::WaitingForWifi => ModelState::WaitingForWifi { received, total },
            Transfer::Idle | Transfer::Running => ModelState::Downloading { received, total },
            Transfer::Failed(failure) => ModelState::Failed {
                received,
                total,
                failure: failure.clone(),
            },
        }
    }

    /// A call while a download runs answers the current state instead of
    /// queueing a second download behind it.
    async fn run_download(&self) -> Result<ModelState, SemanticError> {
        let Ok(_download) = self.download.try_lock() else {
            return Ok(self.model_state());
        };
        *lock(&self.transfer) = Transfer::Running;
        let mut end = download::download(&self.model, &*self.transport, &*self.reachability).await;
        // A turn-off mid-write deletes the files under the download.
        if matches!(end, Err(DownloadError::Io(_))) && !self.model.opted_in() {
            end = Ok(DownloadEnd::OptedOut);
        }
        *lock(&self.transfer) = match &end {
            Ok(DownloadEnd::NotOnWifi) => Transfer::WaitingForWifi,
            Ok(DownloadEnd::Complete | DownloadEnd::OptedOut) => Transfer::Idle,
            Err(DownloadError::Failed(failure)) => Transfer::Failed(failure.clone()),
            Err(DownloadError::Io(_)) => Transfer::Failed(DownloadFailure::Storage),
        };
        match end {
            Ok(DownloadEnd::Complete) => self.model.sweep().map_err(io_failed)?,
            Err(DownloadError::Io(error)) => return Err(io_failed(error)),
            Ok(_) | Err(DownloadError::Failed(_)) => {}
        }
        Ok(self.model_state())
    }

    /// The semantic leg of one search over the vault in `vault_dir`, best
    /// first. Empty means FTS only: the query takes no semantic leg, the model
    /// is off, still downloading or loading, or the leg failed. Never waits on
    /// a model load; the first query starts one.
    pub(crate) fn hits(&self, vault_dir: &Path, query: &str) -> Vec<SemanticHit> {
        if !wants_semantic(query) || !self.model.opted_in() || self.model.verified().is_none() {
            return Vec::new();
        }
        let Some(vector) = query_input(query).and_then(|window| self.host.query_vector(&window))
        else {
            return Vec::new();
        };
        let key = self.model.manifest().vector_key;
        self.with_vectors(vault_dir, |conn| {
            nearest(&vector, VectorStore::new(conn).scan(key)?)
        })
        .map(Option::unwrap_or_default)
        .unwrap_or_else(|error| {
            eprintln!("memry-core: semantic leg failed, FTS only: {error}");
            Vec::new()
        })
    }

    fn embedded_notes(&self, vault_dir: &Path) -> Result<u32, StorageError> {
        let key = self.model.manifest().vector_key;
        self.with_vectors(vault_dir, |conn| VectorStore::new(conn).counts(key))
            .map(Option::unwrap_or_default)
    }

    /// Runs `read` on this vault's `vectors.db`, opened once and held, under
    /// the handles lock so `disable` cannot delete the file mid-read. `None`
    /// when the device is opted out.
    fn with_vectors<T>(
        &self,
        vault_dir: &Path,
        read: impl FnOnce(&mut rusqlite::Connection) -> Result<T, StorageError>,
    ) -> Result<Option<T>, StorageError> {
        let path = vault_dir.join("vectors.db");
        let mut handles = lock(&self.vectors);
        // Read under the lock: `disable` may have run since the caller's check.
        let opted_in = self.model.opted_in();
        // Sign-out removes the vault tree under an open handle, which would
        // otherwise keep counting an unlinked file.
        if !opted_in || !path.exists() {
            handles.remove(vault_dir);
        }
        let db = match handles.get(vault_dir) {
            Some(db) => db.clone(),
            None => {
                let Some(db) = vector_db::open(&path, opted_in)? else {
                    return Ok(None);
                };
                handles.insert(vault_dir.to_path_buf(), db.clone());
                db
            }
        };
        db.call_blocking(read).map(Some)
    }
}

/// The notes and journals search indexes: live, readable, and pulled.
fn live_note_count(conn: &rusqlite::Connection) -> Result<u32, StorageError> {
    conn.query_row(
        "SELECT count(*) FROM sync_items
         WHERE item_type IN ('note', 'journal') AND deleted_at IS NULL
           AND corrupt_reason IS NULL AND payload IS NOT NULL",
        [],
        |row| row.get(0),
    )
    .map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })
}

fn io_failed(error: std::io::Error) -> SemanticError {
    StorageError::Failed {
        what: format!("model files: {error}"),
    }
    .into()
}

#[path = "semantic_step.rs"]
mod step;
pub use crate::semantic::ReleaseReason;
pub use crate::semantic::queue::Thermal;
pub use step::{StepConditions, StepOutcome, StepStop};

#[cfg(test)]
#[path = "semantic_tests.rs"]
mod tests;

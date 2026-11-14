//! The driver's record and body cipher: [`AccountCipher`] over a device
//! directory the driver refetches when a signer was missing from it.
//!
//! `VaultSync::sync_now` fetches `GET /auth/devices` before every pass. A
//! driver lives for the session and passes every minute, so it fetches once
//! at start and again only after a lookup missed (chapter 01 §1.4.0: a signer
//! registered since the last fetch is the ordinary case). A record that missed
//! was stored corrupt and the feed cursor moved past it, so the driver re-pulls
//! its id after the refetch ([`DirectoryCipher::take_missed`]). A body update
//! that missed stopped its document's pull or owed it, and a later pull
//! retries it.

use std::collections::{BTreeSet, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use zeroize::Zeroizing;

use crate::api::errors::ApiError;
use crate::protocol::account::{AccountCipher, DeviceDirectory, device_directory};
use crate::protocol::envelope::{EnvelopeError, RecordEnvelope};
use crate::protocol::http::HttpClient;
use crate::sync::body_pull::{CrdtCipher, PackedUpdate};
use crate::sync::pull::RecordCipher;

pub(super) struct DirectoryCipher {
    vault_key: Zeroizing<Vec<u8>>,
    current: RwLock<Arc<Current>>,
    /// Set when any signer, of a record or a body update, was not in the
    /// directory.
    missed: AtomicBool,
    /// The ids of the records whose signer was not in the directory.
    missed_records: Mutex<BTreeSet<String>>,
}

/// The cipher over one fetched directory, and that directory's signer ids.
struct Current {
    cipher: AccountCipher,
    signers: HashSet<String>,
}

impl Current {
    fn over(vault_key: Vec<u8>, directory: DeviceDirectory) -> Arc<Self> {
        let signers = directory.device_ids().into_iter().collect();
        Arc::new(Self {
            cipher: AccountCipher::new(vault_key, directory),
            signers,
        })
    }
}

impl DirectoryCipher {
    pub(super) fn new(vault_key: Vec<u8>, directory: DeviceDirectory) -> Self {
        Self {
            current: RwLock::new(Current::over(vault_key.clone(), directory)),
            vault_key: Zeroizing::new(vault_key),
            missed: AtomicBool::new(false),
            missed_records: Mutex::default(),
        }
    }

    /// Whether a lookup missed since the last [`DirectoryCipher::refresh`].
    pub(super) fn has_missed(&self) -> bool {
        self.missed.load(Ordering::SeqCst)
    }

    /// Refetches the directory. The flag clears before the fetch, so a miss
    /// during it is kept for the next one; a failed fetch sets it again and
    /// keeps the old directory.
    pub(super) async fn refresh(&self, http: &HttpClient) -> Result<(), ApiError> {
        self.missed.store(false, Ordering::SeqCst);
        let directory = match device_directory(http).await {
            Ok(directory) => directory,
            Err(error) => {
                self.missed.store(true, Ordering::SeqCst);
                return Err(error);
            }
        };
        let fresh = Current::over(self.vault_key.to_vec(), directory);
        *self
            .current
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = fresh;
        Ok(())
    }

    /// The ids of the records that missed, taken off the list.
    pub(super) fn take_missed(&self) -> Vec<String> {
        std::mem::take(&mut *self.missed_records_lock())
            .into_iter()
            .collect()
    }

    /// Drops every miss: after a re-pull over a fresh directory, a signer
    /// still missing is not in the account (§1.4.0) and its record stays
    /// corrupt, so retrying it every pass would only repeat the requests.
    pub(super) fn forget_missed(&self) {
        self.missed_records_lock().clear();
        self.missed.store(false, Ordering::SeqCst);
    }

    /// Puts ids back, for a re-pull that could not run.
    pub(super) fn keep_missed(&self, ids: Vec<String>) {
        self.missed_records_lock().extend(ids);
        self.missed.store(true, Ordering::SeqCst);
    }

    fn missed_records_lock(&self) -> std::sync::MutexGuard<'_, BTreeSet<String>> {
        self.missed_records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn current(&self) -> Arc<Current> {
        Arc::clone(
            &self
                .current
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    /// Marks the directory stale when `signer` is not in it.
    fn check(&self, current: &Current, signer: Option<&str>) -> bool {
        let missed = signer.is_some_and(|signer| !current.signers.contains(signer));
        if missed {
            self.missed.store(true, Ordering::SeqCst);
        }
        missed
    }
}

impl RecordCipher for DirectoryCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        let current = self.current();
        if self.check(&current, Some(&envelope.signer_device_id)) {
            self.missed_records_lock().insert(envelope.id.clone());
        }
        RecordCipher::open(&current.cipher, envelope)
    }
}

impl CrdtCipher for DirectoryCipher {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        let current = self.current();
        self.check(&current, update.signer_device_id);
        CrdtCipher::open(&current.cipher, update)
    }

    fn signer_candidates(&self) -> Vec<String> {
        self.current().cipher.signer_candidates()
    }
}

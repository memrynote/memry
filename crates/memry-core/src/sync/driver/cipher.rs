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
use crate::sync::hardening::purged::SignerKeys;
use crate::sync::pull::RecordCipher;

pub(super) struct DirectoryCipher {
    vault_key: Zeroizing<Vec<u8>>,
    current: RwLock<Arc<Current>>,
    /// Set when any signer, of a record or a body update, was not in the
    /// directory.
    missed: AtomicBool,
    /// The ids of the records whose signer was not in the directory.
    missed_records: Mutex<BTreeSet<String>>,
    /// Marker signers a refetch did not name this run, as Electron caches
    /// `null` in `deviceKeyCache`: one refetch per signer per run.
    absent_signers: Mutex<HashSet<String>>,
}

/// The cipher over one fetched directory, that directory, and its signer ids.
struct Current {
    cipher: AccountCipher,
    directory: DeviceDirectory,
    signers: HashSet<String>,
}

impl Current {
    fn over(vault_key: Vec<u8>, directory: DeviceDirectory) -> Arc<Self> {
        let signers = directory.device_ids().into_iter().collect();
        Arc::new(Self {
            cipher: AccountCipher::new(vault_key, directory.clone()),
            directory,
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
            absent_signers: Mutex::default(),
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
        if let Err(error) = self.refetch(http).await {
            self.missed.store(true, Ordering::SeqCst);
            return Err(error);
        }
        Ok(())
    }

    /// Fetches the directory and makes it current, leaving the misses alone.
    async fn refetch(&self, http: &HttpClient) -> Result<Arc<Current>, ApiError> {
        let directory = device_directory(http).await?;
        let fresh = Current::over(self.vault_key.to_vec(), directory);
        *self
            .current
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::clone(&fresh);
        Ok(fresh)
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

    fn absent_signers_lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.absent_signers
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

/// A purged tombstone's signer (chapter 05 §5.12.3), as Electron's
/// `resolveDeviceKey`: the directory first, then one refetch. The refetch
/// leaves the record misses for [`DirectoryCipher::take_missed`], and a failed
/// one fails the page, so the cursor holds and the marker is read again.
#[async_trait::async_trait]
impl SignerKeys for DirectoryCipher {
    async fn signing_key(
        &self,
        http: &HttpClient,
        device_id: &str,
    ) -> Result<Option<Vec<u8>>, ApiError> {
        if let Some(key) = self.current().directory.signing_key(device_id) {
            return Ok(Some(key.to_vec()));
        }
        if self.absent_signers_lock().contains(device_id) {
            return Ok(None);
        }
        let fresh = self.refetch(http).await?;
        let key = fresh.directory.signing_key(device_id).map(<[u8]>::to_vec);
        if key.is_none() {
            self.absent_signers_lock().insert(device_id.to_owned());
        }
        Ok(key)
    }

    fn begin_run(&self) {
        self.absent_signers_lock().clear();
    }

    fn known_devices(&self) -> Option<HashSet<String>> {
        let signers = &self.current().signers;
        (!signers.is_empty()).then(|| signers.clone())
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

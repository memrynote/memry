//! The driver's record and body cipher: [`AccountCipher`] over a device
//! directory the driver refetches when a signer was missing from it.
//!
//! `VaultSync::sync_now` fetches `GET /auth/devices` before every pass. A
//! driver lives for the session and passes every minute, so it fetches once
//! at start and again only before the pass after a lookup missed (chapter 01
//! §1.4.0: a signer registered since the last fetch is the ordinary case).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

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
    /// Set when a signer was not in the directory.
    missed: AtomicBool,
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
        }
    }

    /// Refetches the directory when the last lookup missed. A failed fetch
    /// keeps the old directory and the flag, so the next pass tries again.
    pub(super) async fn refresh_if_missed(&self, http: &HttpClient) -> Result<(), ApiError> {
        if !self.missed.load(Ordering::SeqCst) {
            return Ok(());
        }
        let directory = device_directory(http).await?;
        let fresh = Current::over(self.vault_key.to_vec(), directory);
        *self
            .current
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = fresh;
        self.missed.store(false, Ordering::SeqCst);
        Ok(())
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
    fn check(&self, current: &Current, signer: Option<&str>) {
        if signer.is_some_and(|signer| !current.signers.contains(signer)) {
            self.missed.store(true, Ordering::SeqCst);
        }
    }
}

impl RecordCipher for DirectoryCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        let current = self.current();
        self.check(&current, Some(&envelope.signer_device_id));
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

//! One pull-then-push pass (spec 004 TP028a).
//!
//! Until this landed the FFI surface could fill a vault and never empty its
//! outbox: every phone write was durable locally and invisible everywhere
//! else. The pass is the only write verb, and it is **pull first, then push**,
//! never push alone — chapter 06 §6.5.2: a field-merged type pushed without
//! pulling first silently destroys a concurrent peer's field.
//!
//! 1. Records: `GET /sync/changes` + `POST /sync/pull` from the stored cursor
//!    to the end ([`PullLoop::run`]).
//! 2. Bodies: the CRDT log of every note or journal whose record arrived in
//!    step 1, so a checkbox flipped in a note on desktop reaches the phone's
//!    copy of that note (FR-058) without waiting for the note to be opened.
//! 3. Push: the outbox drained by [`PushCoordinator`], sealed with this
//!    device's identity ([`AccountSealer`]).

use std::sync::Arc;

use rusqlite::params;
use zeroize::Zeroizing;

use super::{VaultSync, now_ms};
use crate::api::errors::{StorageError, SyncError};
use crate::crypto::keys;
use crate::protocol::account::{AccountSealer, DeviceSigner};
use crate::protocol::types::Declaration;
use crate::sync::body_pull::BodyPull;
use crate::sync::pull::{PullError, PullLoop};
use crate::sync::push::{PushCoordinator, PushError};

/// Pages one pass may pull before it stops and lets the next pass continue.
const MAX_PULL_PAGES: u32 = 200;

/// What one pass did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SyncPassSummary {
    /// Records applied locally.
    pub pulled: u32,
    /// Records deleted locally.
    pub deleted: u32,
    /// Documents whose body log was pulled.
    pub bodies: u32,
    /// Outbox rows the server accepted.
    pub pushed: u32,
    /// Outbox rows the server rejected and that stay queued.
    pub rejected: u32,
    /// Rows still queued after the pass.
    pub pending: u32,
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl From<PullError> for SyncError {
    fn from(error: PullError) -> Self {
        match error {
            PullError::Api { source } => SyncError::Api { source },
            PullError::Storage { source } => SyncError::Storage { source },
        }
    }
}

impl From<PushError> for SyncError {
    fn from(error: PushError) -> Self {
        match error {
            PushError::Api { source } => SyncError::Api { source },
            PushError::Storage { source } => SyncError::Storage { source },
        }
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl VaultSync {
    /// One pass: pull records, pull the bodies they touched, then push.
    ///
    /// **`async`**: tens of round trips on a busy vault. Like every sync call
    /// it cannot be cancelled from the shell (spec-defect 108); a killed pass
    /// resumes at the last cursor it committed, and an unsent outbox row stays
    /// queued. Safe to call repeatedly; concurrent calls simply run twice.
    pub async fn sync_now(&self) -> Result<SyncPassSummary, SyncError> {
        let started = now_ms();
        let cipher = self.cipher().await?;
        let http = self.session.http();

        let pulled = PullLoop::new(
            Arc::clone(&http),
            self.db.clone(),
            Declaration::subscribed(),
            cipher.clone(),
        )
        .with_vault(&self.vault_id)
        .run(MAX_PULL_PAGES)
        .await?;

        let touched = self
            .db
            .call(move |conn| {
                let mut statement = conn
                    .prepare(
                        "SELECT id FROM notes WHERE deleted_at IS NULL AND synced_at >= ?1
                         UNION
                         SELECT id FROM journal_entries WHERE deleted_at IS NULL AND synced_at >= ?1",
                    )
                    .map_err(|e| StorageError::Failed {
                        what: e.to_string(),
                    })?;
                let ids = statement
                    .query_map(params![started], |row| row.get::<_, String>(0))
                    .map_err(|e| StorageError::Failed {
                        what: e.to_string(),
                    })?
                    .collect::<Result<Vec<String>, _>>()
                    .map_err(|e| StorageError::Failed {
                        what: e.to_string(),
                    })?;
                Ok(ids)
            })
            .await?;
        let bodies = BodyPull::new(
            Arc::clone(&http),
            self.db.clone(),
            Declaration::subscribed(),
            cipher,
        )
        .with_vault(&self.vault_id)
        .pull_documents(&touched)
        .await?;

        let master_key = Zeroizing::new(self.session.master_key()?.ok_or(SyncError::Locked)?);
        let vault_key = Zeroizing::new(keys::derive_vault_key(&master_key)?.to_vec());
        // The server's id for this device, not the local clock id: the server
        // finds the signer among registered devices (`registered_device_id`).
        let signer = DeviceSigner::new(
            &self.session.registered_device_id()?,
            self.session.signing_secret_key()?,
        )
        .map_err(|e| StorageError::Failed {
            what: e.to_string(),
        })?;
        let sealer = Arc::new(AccountSealer::new(vault_key.to_vec(), signer));
        let push = PushCoordinator::new(http, self.db.clone(), Declaration::subscribed(), sealer)
            .with_vault(&self.vault_id);
        let report = push.drain_wave().await?;
        let pending = self
            .db
            .call(|conn| {
                conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|e| StorageError::Failed {
                    what: e.to_string(),
                })
            })
            .await?;

        Ok(SyncPassSummary {
            pulled: count(pulled.applied),
            deleted: count(pulled.deleted),
            bodies: count(bodies.documents),
            pushed: count(report.accepted),
            rejected: count(report.rejected),
            pending: u32::try_from(pending).unwrap_or(u32::MAX),
        })
    }
}

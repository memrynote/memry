//! `sync:repair-device-keys` (Electron `sync/device-registration.ts:378-460`): the sync status
//! says this device's keys are missing. When the account still lists the device key this install
//! holds, only local state was lost: `sync.deviceId` is written again and the caller restarts
//! sync. Otherwise nothing here can sign for the account again, so the device signs out the
//! `integrity` way, which keeps the master key and the vault's queue, and the next sign-in
//! registers new keys.
//!
//! Departures, both on the side that deletes nothing: a keychain that does not answer, a network
//! failure or any server error other than a refused session is an error the user can retry, where
//! Electron's failed key read signs out (`.catch(() => null)`). Tauri keeps no device row, so the
//! row Electron re-inserts has no counterpart.

use serde_json::Value;

use super::teardown::Reason;
use super::{AccountError, AccountService};
use crate::session::Session;
use memry_core::api::auth::AuthState;
use memry_core::api::errors::AuthError;

/// What a repair found, before sync restarts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyRepair {
    /// The server lists this install's device key; `sync.deviceId` holds its id again.
    Listed,
    /// Signed out with the master key and the queue kept: sign in to set up new keys.
    SignInRequired,
}

impl AccountService {
    /// One repair at a time, beside no other key-changing operation.
    pub async fn repair_device_keys(&self, session: &Session) -> Result<KeyRepair, AccountError> {
        let _op = self.key_op.lock().await;
        if let Some(device_id) = self.listed_device().await? {
            self.write_sync(|sync| {
                sync.insert("deviceId".into(), Value::from(device_id));
            })?;
            tracing::info!(
                scope = "Sync",
                "restored the device id from the registered key"
            );
            return Ok(KeyRepair::Listed);
        }
        tracing::warn!(
            scope = "Sync",
            "device keys cannot be restored on this device, signing out to set up new ones"
        );
        let _term = self.epoch.end();
        let signed_out = self.teardown(session, Reason::Integrity).await?;
        if let Some(warning) = signed_out.keychain_warning() {
            tracing::warn!(scope = "Sync", "{warning}");
        }
        Ok(KeyRepair::SignInRequired)
    }

    /// The session's own state, read in memory: a repair's teardown signed it out even when a later
    /// step failed. Unlike `info().signed_in`, a device registered without a master key is not
    /// signed out.
    pub fn is_signed_out(&self) -> bool {
        self.session.state() == AuthState::SignedOut
    }

    /// The server's id for this install's device key; `None` with no session, a session that
    /// cannot be refreshed, no device key, or a key no live device holds. A 401 on the device list
    /// itself is an error, as Electron's `getFromServer` throws.
    async fn listed_device(&self) -> Result<Option<String>, AccountError> {
        match self.session.valid_access_token().await {
            Ok(Some(_)) => {}
            Ok(None) | Err(AuthError::SessionExpired) => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        Ok(self.session.listed_device_id().await?)
    }
}

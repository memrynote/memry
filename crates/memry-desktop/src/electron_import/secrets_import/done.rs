//! The phase's done marker, `secrets-import.done` in this app's data dir: `{"sync": [...]}`, a
//! sha256 of each sync entry the phase left holding Electron's value. A rerun after a failed
//! first launch removes those copies and nothing else, so an entry this app wrote since (a
//! sign-in here) no longer matches and stays.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::{Secret, SecretsError, kind};
use crate::seams::secure_store::{KeyringStore, STORE_KEYS};
use crate::vault::fs_atomic::atomic_write;

pub(super) const DONE_FILE: &str = "secrets-import.done";

#[derive(Default, Serialize, Deserialize)]
struct Done {
    /// [`digest`] of each sync entry the phase wrote or found holding Electron's value.
    #[serde(default)]
    sync: Vec<String>,
}

/// sha256 over the entry's kind and value, hex. The values are random keys and tokens, so the
/// digest gives nothing away.
fn digest(key: SecureStoreKey, value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind(key).as_bytes());
    hasher.update([0]);
    hasher.update(value);
    hex::encode(hasher.finalize())
}

/// Written after a run that ended `Ok`, naming the sync entries it put in place.
pub(super) fn mark_done(
    app_dir: &Path,
    sync: &[(SecureStoreKey, Secret)],
) -> Result<(), SecretsError> {
    let done = Done {
        sync: sync
            .iter()
            .map(|(key, value)| digest(*key, value))
            .collect(),
    };
    let bytes = serde_json::to_vec(&done).map_err(|e| SecretsError::DoneMarker(e.to_string()))?;
    atomic_write(&app_dir.join(DONE_FILE), &bytes)
        .map_err(|error| SecretsError::DoneMarker(error.source.to_string()))
}

/// Undoes the done marker of a run whose secrets nothing used yet, so the next
/// [`super::import_secrets`] copies Electron's current values: the first-launch run after a
/// failure, when the user went back to the previous app, which may have refreshed its tokens
/// since. Removes each sync entry that still holds the value the marker names; an entry holding
/// anything else stays, and the next run refuses to overwrite it (`TargetOccupied`). The device
/// key and generic secrets stay too. The marker goes last: a failure part way leaves it, and the
/// next call finishes the job.
pub fn forget_secrets_import(keyring: &KeyringStore, app_dir: &Path) -> Result<(), SecretsError> {
    let path = app_dir.join(DONE_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(SecretsError::DoneMarker(error.to_string())),
    };
    let done: Done = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        tracing::warn!(
            scope = "ElectronImport",
            "the secrets done marker names no entry; every sync entry is kept"
        );
        Done::default()
    });
    for key in STORE_KEYS {
        let held = keyring.get(key)?.map(Zeroizing::new);
        if held.is_some_and(|value| done.sync.contains(&digest(key, &value))) {
            keyring.delete(key)?;
        }
    }
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SecretsError::DoneMarker(error.to_string())),
    }
}

//! `secure-secrets.json` (Electron safeStorage) and the merge with legacy keytar items.
//!
//! The reader never reports a secret as absent when it exists but could not be read: an entry
//! present in the store that does not decrypt lands in [`SecretsReport::unreadable`] with a
//! reason (the false-absent rule of `secret-storage.ts`), which feeds the migration's refusal to
//! regenerate a master key.

pub mod chromium;
pub mod key_source;
pub mod keytar;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod merge;
mod os;
mod timeout;
#[cfg(windows)]
mod windows;

use std::collections::BTreeMap;
use std::fmt;
use std::fs;

use serde_json::Value;
use zeroize::Zeroizing;

pub use self::key_source::{ChromiumKeySource, FixedKeySource, KeySourceError};
pub use self::keytar::{KeytarSource, NoKeytar};
pub use self::merge::read_all_secrets;
pub use self::os::{OsKeySource, OsKeytar};
pub use self::timeout::Guarded;
use super::ImportError;
use super::profile::ElectronProfile;

/// `service -> account -> base64 ciphertext`, as `secure-secrets.json` v1 holds them.
#[derive(Debug, Clone, Default)]
pub struct SecretStoreFile {
    pub entries: BTreeMap<String, BTreeMap<String, StoreLeaf>>,
    /// Services whose value is not an object: nothing can be told about their accounts, so each
    /// is reported as one corrupt entry instead of vanishing.
    pub malformed_services: Vec<String>,
}

/// A store leaf. A non-string leaf is kept so the reader reports it, never drops it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreLeaf {
    Ciphertext(String),
    Malformed,
}

impl SecretStoreFile {
    /// `Ok(None)` when the file is absent. Unparseable content is an error: the file is never
    /// renamed aside, as the Electron app does.
    pub fn read(profile: &ElectronProfile) -> Result<Option<Self>, ImportError> {
        let path = profile.secret_store_path();
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(ImportError::io(path, e)),
        };
        Self::parse(&bytes).map(Some)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ImportError> {
        let value: Value = serde_json::from_slice(bytes)
            .map_err(|e| ImportError::parse("secure-secrets.json", e.column()))?;
        // The Electron app writes `version: 1`. An absent field reads (the app never checks it);
        // any other value is a layout this reader was not written for.
        if let Some(version) = value.get("version")
            && version != 1
        {
            return Err(ImportError::UnsupportedVersion {
                what: "secure-secrets.json",
                found: version.to_string(),
            });
        }
        let Some(Value::Object(services)) = value.get("entries") else {
            return Err(ImportError::UnsupportedLayout("secure-secrets.json"));
        };
        let mut store = Self::default();
        for (service, accounts) in services {
            let Value::Object(accounts) = accounts else {
                store.malformed_services.push(service.clone());
                continue;
            };
            let accounts = accounts
                .iter()
                .map(|(account, v)| {
                    let leaf = match v.as_str() {
                        Some(s) => StoreLeaf::Ciphertext(s.to_owned()),
                        None => StoreLeaf::Malformed,
                    };
                    (account.clone(), leaf)
                })
                .collect();
            store.entries.insert(service.clone(), accounts);
        }
        Ok(store)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretSource {
    SafeStorage,
    Keytar,
}

/// One decrypted secret. `Debug` prints service and account only.
pub struct SecretEntry {
    pub service: String,
    pub account: String,
    pub value: Zeroizing<String>,
    pub source: SecretSource,
}

impl fmt::Debug for SecretEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretEntry")
            .field("service", &self.service)
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum UnreadableReason {
    WrongIdentity,
    KeySourceMissing,
    KeySourceDenied,
    /// The key source errored (timeout, D-Bus, DPAPI, Keychain failure): the key may exist, so
    /// this is not "missing". [`UnreadableSecret::detail`] carries the message.
    KeySourceFailed,
    CorruptCiphertext,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableSecret {
    pub service: String,
    pub account: String,
    pub reason: UnreadableReason,
    /// The error message behind `KeySourceFailed`. Never contains a key or a value.
    pub detail: Option<String>,
}

#[derive(Debug, Default)]
pub struct SecretsReport {
    pub entries: Vec<SecretEntry>,
    pub unreadable: Vec<UnreadableSecret>,
    /// Legacy keytar items that could not be listed. Without the listing the report cannot say
    /// what keytar holds, so the caller treats a `Some` as "may be missing items", not "none".
    pub keytar_error: Option<String>,
}

impl SecretsReport {
    pub fn get(&self, service: &str, account: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|e| e.service == service && e.account == account)
            .map(|e| e.value.as_str())
    }
}

#[cfg(test)]
mod invariants;
#[cfg(test)]
mod tests;

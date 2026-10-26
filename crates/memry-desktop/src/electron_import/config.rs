//! `memry-config.json`, the electron-store file of `apps/desktop/src/main/store.ts`.
//!
//! The whole document is kept (unknown keys survive by design) and read through accessors that
//! tolerate every shipped shape: absent keys, older stores and wrong-typed values read as `None`.

use std::fs;

use serde::Deserialize;
use serde_json::{Map, Value};

use super::ImportError;
use super::profile::ElectronProfile;

/// `StoredVaultInfo`. Every field but `path` is optional: older stores lack some.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredVault {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub note_count: Option<u64>,
    #[serde(default)]
    pub task_count: Option<u64>,
    #[serde(default)]
    pub last_opened: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub vault_uuid: Option<String>,
    #[serde(default)]
    pub account_binding: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ElectronConfig {
    pub raw: Map<String, Value>,
}

impl ElectronConfig {
    /// `Ok(None)` when the file does not exist. Invalid JSON is [`ImportError::Parse`] with the
    /// byte offset of the failure and no content.
    pub fn read(profile: &ElectronProfile) -> Result<Option<Self>, ImportError> {
        let path = profile.config_path();
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(ImportError::io(path, e)),
        };
        Self::parse(&bytes).map(Some)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ImportError> {
        match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Object(raw)) => Ok(Self { raw }),
            Ok(_) => Err(ImportError::parse("memry-config.json", 0)),
            Err(e) => Err(ImportError::parse(
                "memry-config.json",
                offset_of(bytes, e.line(), e.column()),
            )),
        }
    }

    /// Vaults in stored order; an entry without a string `path` is skipped.
    pub fn vaults(&self) -> Vec<StoredVault> {
        let Some(Value::Array(items)) = self.raw.get("vaults") else {
            return Vec::new();
        };
        items
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect()
    }

    pub fn current_vault(&self) -> Option<&str> {
        self.raw.get("currentVault")?.as_str()
    }

    pub fn locale(&self) -> Option<&str> {
        self.raw.get("locale")?.as_str()
    }

    pub fn sync_str(&self, key: &str) -> Option<&str> {
        self.raw.get("sync")?.get(key)?.as_str()
    }

    pub fn device_id(&self) -> Option<&str> {
        self.sync_str("deviceId")
    }

    pub fn email(&self) -> Option<&str> {
        self.sync_str("email")
    }

    pub fn account_key_verifier(&self) -> Option<&str> {
        self.sync_str("accountKeyVerifier")
    }

    pub fn recovery_phrase_confirmed(&self) -> Option<bool> {
        self.raw
            .get("sync")?
            .get("recoveryPhraseConfirmed")?
            .as_bool()
    }

    /// Any other top-level section (`sync.entitlement` through `sync_section`, `crdtStore`,
    /// `agent`, `captureAllowedOrigins`, `updater`, `windowBounds`, `ocrLanguages`).
    pub fn section(&self, key: &str) -> Option<&Value> {
        self.raw.get(key)
    }

    pub fn sync_section(&self, key: &str) -> Option<&Value> {
        self.raw.get("sync")?.get(key)
    }
}

fn offset_of(bytes: &[u8], line: usize, column: usize) -> usize {
    let mut offset = 0;
    for (i, chunk) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
        if i + 1 == line {
            return offset + column.saturating_sub(1).min(chunk.len());
        }
        offset += chunk.len();
    }
    bytes.len()
}

#[cfg(test)]
mod tests;

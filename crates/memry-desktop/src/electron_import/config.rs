//! `memry-config.json`, the electron-store file of `apps/desktop/src/main/store.ts`.
//!
//! The whole document is kept (unknown keys survive by design) and read through accessors that
//! tolerate every shipped shape: absent keys, older stores and wrong-typed values read as `None`.

use std::fs;

use serde_json::{Map, Value};

use super::ImportError;
use super::profile::ElectronProfile;

/// `StoredVaultInfo`. Every field but `path` is optional: older stores lack some.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredVault {
    pub path: String,
    pub name: Option<String>,
    pub note_count: Option<u64>,
    pub task_count: Option<u64>,
    pub last_opened: Option<String>,
    pub is_default: bool,
    pub vault_uuid: Option<String>,
    pub account_binding: Option<Value>,
}

impl StoredVault {
    /// Reads each field on its own: a wrong-typed optional field reads as absent and does not
    /// cost the vault its `path`. Only a missing string `path` skips the entry.
    fn from_value(value: &Value) -> Option<Self> {
        let path = value.get("path")?.as_str()?.to_owned();
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        let count = |key: &str| value.get(key).and_then(Value::as_u64);
        Some(Self {
            path,
            name: text("name"),
            note_count: count("noteCount"),
            task_count: count("taskCount"),
            last_opened: text("lastOpened"),
            is_default: value
                .get("isDefault")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            vault_uuid: text("vaultUuid"),
            account_binding: value.get("accountBinding").cloned(),
        })
    }
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

    /// Vaults in stored order and the number of entries that could not be read (no string
    /// `path`, or a wrong-typed field). A skipped entry is reported, not dropped silently.
    pub fn vaults(&self) -> (Vec<StoredVault>, usize) {
        let Some(Value::Array(items)) = self.raw.get("vaults") else {
            return (Vec::new(), 0);
        };
        let vaults: Vec<StoredVault> = items.iter().filter_map(StoredVault::from_value).collect();
        let skipped = items.len() - vaults.len();
        (vaults, skipped)
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

    /// `crdtStore.pendingRenames[vaultUuid]`: the uuid the vault's CRDT store directory is still
    /// named after, when the vault adopted a new uuid (device linking) and its store was not yet
    /// renamed (`store.ts` `recordCrdtStoreRename`).
    pub fn crdt_pending_rename(&self, vault_uuid: &str) -> Option<&str> {
        self.crdt_store()?
            .get("pendingRenames")?
            .get(vault_uuid)?
            .as_str()
    }

    /// `crdtStore.legacyStoreClaimedBy`: the one vault uuid that inherited the global legacy
    /// `crdt-store/`. Absent means unclaimed.
    pub fn legacy_store_claimed_by(&self) -> Option<&str> {
        self.crdt_store()?.get("legacyStoreClaimedBy")?.as_str()
    }

    /// `crdtStore.legacyStorePartitionPendingFor`: the vault that still owes its inherited legacy
    /// store a partition pass. Set means that store holds documents of other vaults.
    pub fn legacy_store_partition_pending_for(&self) -> Option<&str> {
        self.crdt_store()?
            .get("legacyStorePartitionPendingFor")?
            .as_str()
    }

    fn crdt_store(&self) -> Option<&Value> {
        self.raw.get("crdtStore")
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

//! The values of an Electron vault's `.memry/data.db` the secrets phase checks against: the vault
//! uuid, the local vault key verifier, the current-device row's id and registered public key, and whether
//! the inline AI row holds a key the user must enter again.
//!
//! The database is never opened in place: an open in WAL mode can create `-shm` and checkpoint
//! into the file. It is copied with its `-wal` into a temporary directory under `scratch_dir`,
//! which is removed when the read ends, and the copy is read.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::Value;

use super::ImportError;

/// `vault.crypto.verifier.v1` (`crypto/vault-key-state.ts:17`).
const VERIFIER_KEY: &str = "vault.crypto.verifier.v1";
/// `ai-inline` (`ipc/ai-inline-handlers.ts:16`).
const AI_INLINE_KEY: &str = "ai-inline";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultEvidence {
    /// `vault_metadata.vault_uuid`, the vault id of the verifier.
    pub vault_id: Option<String>,
    /// The `vault.crypto.verifier.v1` settings row.
    pub key_verifier: Option<String>,
    /// `sync_devices.id` of the row with `is_current_device = 1`: a vault not open at sign-out
    /// keeps the previous session's row (`vault-account-binding.ts:270-275`).
    pub device_id: Option<String>,
    /// `signing_public_key` of that row, base64.
    pub device_public_key: Option<String>,
    /// The `ai-inline` row selects Ollama and holds an `apiKey`: Step 22's `InlineAiStore::read`
    /// moves that key into the legacy entry, never into a provider's slot, so the user enters
    /// it again after choosing a cloud provider (#3554 comment from #4483).
    pub inline_ai_reenter: bool,
}

fn sqlite(error: rusqlite::Error) -> ImportError {
    ImportError::Sqlite(format!("vault data.db: {error}"))
}

fn copy_if_present(from: &Path, to: &Path) -> Result<bool, ImportError> {
    match fs::copy(from, to) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ImportError::io(from, error)),
    }
}

/// `Ok(None)` when the vault has no `.memry/data.db`.
pub fn read_vault_evidence(
    vault_root: &Path,
    scratch_dir: &Path,
) -> Result<Option<VaultEvidence>, ImportError> {
    let source = vault_root.join(".memry").join("data.db");
    let copy_dir =
        tempfile::tempdir_in(scratch_dir).map_err(|e| ImportError::io(scratch_dir, e))?;
    let copy = copy_dir.path().join("data.db");
    if !copy_if_present(&source, &copy)? {
        return Ok(None);
    }
    copy_if_present(
        &vault_root.join(".memry").join("data.db-wal"),
        &copy_dir.path().join("data.db-wal"),
    )?;
    let db = Connection::open_with_flags(
        &copy,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sqlite)?;
    read(&db).map(Some)
}

fn has_column(db: &Connection, table: &str, column: &str) -> Result<bool, ImportError> {
    let mut statement = db
        .prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2")
        .map_err(sqlite)?;
    statement.exists(params![table, column]).map_err(sqlite)
}

fn read(db: &Connection) -> Result<VaultEvidence, ImportError> {
    let text = |sql: &str, arg: Option<&str>| -> Result<Option<String>, ImportError> {
        let row = match arg {
            Some(arg) => db.query_row(sql, [arg], |r| r.get::<_, Option<String>>(0)),
            None => db.query_row(sql, [], |r| r.get::<_, Option<String>>(0)),
        };
        row.optional().map(Option::flatten).map_err(sqlite)
    };
    let setting = |key: &str| -> Result<Option<String>, ImportError> {
        if !has_column(db, "settings", "value")? {
            return Ok(None);
        }
        text("SELECT value FROM settings WHERE key = ?1", Some(key))
    };
    let vault_id = if has_column(db, "vault_metadata", "vault_uuid")? {
        text("SELECT vault_uuid FROM vault_metadata LIMIT 1", None)?
    } else {
        None
    };
    // `signing_public_key` arrived in Electron's data migration 0012. The row Electron's
    // integrity check reads: the first current-device row (`sync-core-handlers.ts:98-102`).
    let (device_id, device_public_key) = if has_column(db, "sync_devices", "signing_public_key")? {
        db.query_row(
            "SELECT id, signing_public_key FROM sync_devices WHERE is_current_device = 1 LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sqlite)?
        .unwrap_or_default()
    } else {
        (None, None)
    };
    let inline_ai_reenter = setting(AI_INLINE_KEY)?
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .is_some_and(|row| {
            row.get("provider").and_then(Value::as_str) == Some("ollama")
                && row
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .is_some_and(|key| !key.trim().is_empty())
        });
    Ok(VaultEvidence {
        vault_id,
        key_verifier: setting(VERIFIER_KEY)?,
        device_id,
        device_public_key,
        inline_ai_reenter,
    })
}

#[cfg(test)]
mod tests;

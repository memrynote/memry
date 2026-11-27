//! The vault's identity: one UUID v4 in `meta.vault.id`, minted once, read on every open.
//!
//! An unbound vault stamps it into synced records (a canvas carries it as `vaultId`), so it
//! must not depend on where the folder lives: a path-derived id changed when the folder was
//! renamed or moved. Once the vault is bound to a server vault, records state the server id
//! instead and list under either (`sync::server_vault::RecordVault`, #5505), as Electron's adopted
//! `getOrCreateVaultUuid` does.
//!
//! **Never overwritten.** A present value is the id, whatever it holds; an empty or
//! malformed one is an error, not a reason to mint over it (a second id would orphan every
//! record that carries the first). The mint is `INSERT OR IGNORE` followed by a re-read, so
//! two first opens settle on one id.
//!
//! The server vault uuid (`vaultUuid` in the registry) is a different thing, stamped by
//! sync (Step 17). When Step 17 binds a vault it should write through a core operation, with
//! the registry as a cache of it, rather than become a second owner.
//!
//! The recovery rebuild does not call this: the salvage carries `meta` (with `vault.id`) into
//! the fresh database, and the next open reads it. Minting inside the rebuild would win over
//! the salvaged row (salvage never overwrites a live row).

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::crypto::sodium;

const KEY: &str = "vault.id";

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

/// A random (version 4) UUID in its canonical lowercase form.
fn mint() -> String {
    let mut b = sodium::random_bytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn is_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12])
        && groups
            .iter()
            .all(|g| g.bytes().all(|c| c.is_ascii_hexdigit()))
}

/// The stored id, or `None` before the first mint.
pub(crate) fn read(conn: &Connection) -> Result<Option<String>, StorageError> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [KEY], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(failed)
}

/// The Electron import's write into a fresh staged database: Electron's `vault_metadata` uuid,
/// byte for byte, so the canvases and agent records that carry it stay this vault's. A value
/// that is not a UUID is refused here rather than by every later open.
pub(crate) fn write_imported(conn: &Connection, id: &str) -> Result<(), StorageError> {
    if !is_uuid(id) {
        return Err(StorageError::Failed {
            what: "the Electron vault uuid is not a UUID".to_owned(),
        });
    }
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)",
        params![KEY, id],
    )
    .map(drop)
    .map_err(failed)
}

/// The vault's id, minted on first use. Call after migrations, on the writer.
pub fn resolve(conn: &mut Connection) -> Result<String, StorageError> {
    if read(conn)?.is_none() {
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)",
            params![KEY, mint()],
        )
        .map_err(failed)?;
    }
    let id = read(conn)?.ok_or_else(|| StorageError::Failed {
        what: "the vault id could not be stored".to_owned(),
    })?;
    if !is_uuid(&id) {
        return Err(StorageError::Failed {
            what: format!("meta.{KEY} is not a UUID; refusing to replace it"),
        });
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::open_data;
    use crate::storage::test_support::temp_dir;

    #[test]
    fn the_id_is_minted_once_and_read_on_every_later_open() {
        let dir = temp_dir("vault-identity");
        let path = dir.path().join("data.db");
        let first = open_data(&path)
            .expect("open")
            .call_blocking(resolve)
            .expect("id");
        assert!(is_uuid(&first) && first.as_bytes()[14] == b'4');
        let again = open_data(&path)
            .expect("reopen")
            .call_blocking(resolve)
            .expect("id");
        assert_eq!(first, again);
    }

    #[test]
    fn a_stored_value_is_never_replaced_even_when_malformed() {
        let dir = temp_dir("vault-identity-bad");
        let path = dir.path().join("data.db");
        let db = open_data(&path).expect("open");
        db.call_blocking(|c| {
            c.execute(
                "INSERT INTO meta (key, value) VALUES ('vault.id', 'local:abc')",
                [],
            )
            .map(drop)
            .map_err(failed)
        })
        .expect("seed");
        assert!(db.call_blocking(resolve).is_err());
        let stored: String = db
            .read_blocking(|c| {
                c.query_row("SELECT value FROM meta WHERE key = 'vault.id'", [], |r| {
                    r.get(0)
                })
                .map_err(failed)
            })
            .expect("row");
        assert_eq!(stored, "local:abc");
    }
}

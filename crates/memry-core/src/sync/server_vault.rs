//! The server's id for this vault, which `X-Memry-Vault-Id` and the socket
//! carry (chapter 05 §5.2), owned by core as one `meta` key (#3534 decision K1).
//!
//! Electron kept it in the vault registry (`vaultUuid`); here the registry
//! entry becomes a cache of this key, so a vault opened from another path or
//! after a registry reset still syncs to the vault the server knows. It is
//! never the local `vault.id` (`storage::vault_identity`), which canvases
//! stamp and which stays per database, as Electron's does.
//!
//! Additive: an older build ignores the key. `SyncDriver` refuses a vault with
//! none, which would send no header and be routed to the account's only vault.

use rusqlite::Connection;

use crate::api::errors::StorageError;

use super::first_sync_store::{read_meta, write_meta};

/// `meta` key of the bound server vault id.
pub const META_SERVER_VAULT_ID: &str = "sync.server_vault_id";

/// Binds this vault to the server's vault `id`. Binding the id it already
/// has is a no-op; another id is refused, because the feed cursor, the outbox
/// and every stored record belong to the vault first bound. An empty or
/// whitespace id is refused: it would send an empty header.
pub fn bind(conn: &Connection, id: &str) -> Result<(), StorageError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(StorageError::Failed {
            what: "a server vault id is empty".into(),
        });
    }
    match bound(conn)? {
        Some(current) if current == id => Ok(()),
        Some(current) => Err(StorageError::Failed {
            what: format!("this vault is bound to server vault `{current}`, not `{id}`"),
        }),
        None => write_meta(conn, META_SERVER_VAULT_ID, id),
    }
}

/// The bound server vault id, if any.
pub fn bound(conn: &Connection) -> Result<Option<String>, StorageError> {
    read_meta(conn, META_SERVER_VAULT_ID)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    #[test]
    fn a_binding_is_kept_across_a_reopen_and_an_empty_or_other_id_is_refused() {
        let dir = temp_dir("server-vault");
        let path = dir.path().join("data.db");
        let db = open_data(&path).expect("open");
        db.call_blocking(|conn| {
            assert_eq!(bound(conn)?, None);
            assert!(bind(conn, "  ").is_err());
            bind(conn, "vault-1")?;
            assert!(bind(conn, "vault-2").is_err());
            bind(conn, " vault-1 ")
        })
        .expect("bind");
        drop(db);
        let db = open_data(&path).expect("reopen");
        let id = db.call_blocking(|conn| bound(conn)).expect("read");
        assert_eq!(id.as_deref(), Some("vault-1"));
    }
}

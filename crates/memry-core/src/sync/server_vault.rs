//! The server's id for this vault, which `X-Memry-Vault-Id` and the socket
//! carry (chapter 05 §5.2), owned by core as one `meta` key (#3534 decision K1).
//!
//! Electron kept it in the vault registry (`vaultUuid`); here the registry
//! entry becomes a cache of this key, so a vault opened from another path or
//! after a registry reset still syncs to the vault the server knows. It is
//! never the local `vault.id` (`storage::vault_identity`), which canvases
//! stamp and which stays per database, as Electron's does.
//!
//! Additive: an older build ignores the key, and a vault with none sends no
//! header, as before.

use rusqlite::Connection;

use crate::api::errors::StorageError;

use super::first_sync_store::{read_meta, write_meta};

/// `meta` key of the bound server vault id.
pub const META_SERVER_VAULT_ID: &str = "sync.server_vault_id";

/// Binds this vault to the server's vault `id`, replacing any earlier binding.
/// An empty or whitespace id is refused: it would send an empty header.
pub fn bind(conn: &Connection, id: &str) -> Result<(), StorageError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(StorageError::Failed {
            what: "a server vault id is empty".into(),
        });
    }
    write_meta(conn, META_SERVER_VAULT_ID, id)
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
    fn a_binding_is_kept_across_a_reopen_and_an_empty_id_is_refused() {
        let dir = temp_dir("server-vault");
        let path = dir.path().join("data.db");
        let db = open_data(&path).expect("open");
        db.call_blocking(|conn| {
            assert_eq!(bound(conn)?, None);
            assert!(bind(conn, "  ").is_err());
            bind(conn, "vault-1")?;
            bind(conn, " vault-2 ")
        })
        .expect("bind");
        drop(db);
        let db = open_data(&path).expect("reopen");
        let id = db.call_blocking(|conn| bound(conn)).expect("read");
        assert_eq!(id.as_deref(), Some("vault-2"));
    }
}

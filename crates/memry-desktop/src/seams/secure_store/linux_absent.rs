//! Linux: what "no entry" has to rule out before the store answers "absent".
//!
//! The zbus store finds an item by the attributes `service` and `username`. Electron's keytar
//! wrote `service` and `account` (`keytar_posix.cc`), so a vault written by the Electron app is
//! invisible to that search, and answering "absent" for its master key would make the app mint
//! a new device identity. Two checks run when the search found nothing:
//!
//! 1. A read-only search for `service` + `account`, the keytar attributes. A hit is the secret.
//! 2. A locked default collection hides its items from a search (a cold gnome-keyring shows only
//!    hashed attributes; KeePassXC and KWallet behave alike), so "found nothing" proves nothing
//!    while it is locked. The answer is then `NoStorageAccess`, which the store maps to `Locked`.
//!
//! Nothing here writes or creates a collection.

use std::collections::HashMap;

use keyring_core::Error;
use secret_service::blocking::SecretService;
use secret_service::{EncryptionType, Error as SsError};

/// The default collection: where keytar and this store both write. When the service has none,
/// any locked collection counts.
const DEFAULT_ALIAS: &str = "default";

fn unreachable(error: SsError) -> Error {
    Error::NoStorageAccess(Box::new(error))
}

pub fn check(service: &str, account: &str) -> keyring_core::Result<Option<Vec<u8>>> {
    let ss = SecretService::connect(EncryptionType::Dh).map_err(unreachable)?;
    let found = ss
        .search_items(HashMap::from([("service", service), ("account", account)]))
        .map_err(unreachable)?;
    if let Some(item) = found.unlocked.first().or(found.locked.first()) {
        // A locked item is unlocked here: the service prompts the user once for its collection.
        item.unlock().map_err(unreachable)?;
        return item.get_secret().map(Some).map_err(unreachable);
    }
    let locked = match ss.get_collection_by_alias(DEFAULT_ALIAS) {
        Ok(default) => default.is_locked().map_err(unreachable)?,
        Err(SsError::NoResult) => {
            let mut any = false;
            for collection in ss.get_all_collections().map_err(unreachable)? {
                any |= collection.is_locked().map_err(unreachable)?;
            }
            any
        }
        Err(other) => return Err(unreachable(other)),
    };
    if locked {
        return Err(unreachable(SsError::Locked));
    }
    Ok(None)
}

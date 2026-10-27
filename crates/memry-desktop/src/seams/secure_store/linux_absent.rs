//! Linux: the items Electron's keytar wrote, and what "no entry" has to rule out.
//!
//! The zbus store finds an item by the attributes `service` and `username`. Electron's keytar
//! wrote and reads `service` and `account` (`keytar_posix.cc`). So that exactly one item answers
//! for a (service, account) pair after any write, and both apps see it:
//!
//! - **get** ([`check`], when the store found nothing): a search for `service` + `account`. A hit
//!   is the secret.
//! - **set** ([`after_set`]): the store's item gets keytar's `account` attribute too, then every
//!   other item with keytar's attributes is deleted, so the Electron app reads the new value and
//!   no stale secret stays. A crash between the two leaves the store's item, which every read of
//!   this app finds first, and the next write removes the other.
//! - **delete** ([`after_delete`]): every item with keytar's attributes is deleted, so the read
//!   fallback cannot bring a deleted secret back.
//!
//! A locked default collection hides its items from a search (a cold gnome-keyring shows only
//! hashed attributes; KeePassXC and KWallet behave alike), so "found nothing" proves nothing while
//! it is locked. The answer is then `NoStorageAccess`, which the store maps to `Locked`: a read is
//! never "absent" and a delete never reports success over an item it could not see.
//!
//! **Accepted residual.** Only the default collection's lock counts (every collection's when the
//! service has no default alias). An item in another collection that is locked (the user moved the
//! default alias after Electron wrote it) is not seen, and a read answers "absent". Counting every
//! collection would answer `Locked` for every absent token while some unrelated keyring stays
//! locked, with nothing that prompts the user to fix it. A caller that knows its secret must exist
//! cannot take "absent" as proof that it does not.
//!
//! The Secret Service connection is kept between calls and dropped after any failure, so a service
//! that restarts is found again by the next call. Nothing here creates a collection.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use keyring_core::{Entry, Error};
use secret_service::blocking::{Item, SecretService};
use secret_service::{EncryptionType, Error as SsError};

/// The default collection: where keytar and this store both write. When the service has none,
/// any locked collection counts.
const DEFAULT_ALIAS: &str = "default";

fn unreachable(error: SsError) -> Error {
    Error::NoStorageAccess(Box::new(error))
}

/// The Secret Service connection of the keyring thread, kept between calls.
#[derive(Default)]
pub struct Session(Mutex<Option<SecretService<'static>>>);

impl Session {
    fn run<T>(
        &self,
        work: impl for<'s> FnOnce(&'s SecretService<'s>) -> Result<T, SsError>,
    ) -> keyring_core::Result<T> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let ss = match slot.take() {
            Some(ss) => ss,
            None => SecretService::connect(EncryptionType::Dh).map_err(unreachable)?,
        };
        let outcome = work(&ss);
        if outcome.is_ok() {
            *slot = Some(ss);
        }
        outcome.map_err(unreachable)
    }
}

/// The items with keytar's attributes for the pair. When there are none and the default
/// collection is locked, `SsError::Locked`: a locked collection may hide one.
fn keytar_items<'s>(
    ss: &'s SecretService<'s>,
    service: &str,
    account: &str,
) -> Result<Vec<Item<'s>>, SsError> {
    let found = ss.search_items(HashMap::from([("service", service), ("account", account)]))?;
    let items: Vec<Item<'s>> = found.unlocked.into_iter().chain(found.locked).collect();
    if items.is_empty() && default_collection_is_locked(ss)? {
        return Err(SsError::Locked);
    }
    Ok(items)
}

fn default_collection_is_locked(ss: &SecretService<'_>) -> Result<bool, SsError> {
    match ss.get_collection_by_alias(DEFAULT_ALIAS) {
        Ok(default) => default.is_locked(),
        Err(SsError::NoResult) => {
            let mut any = false;
            for collection in ss.get_all_collections()? {
                any |= collection.is_locked()?;
            }
            Ok(any)
        }
        Err(other) => Err(other),
    }
}

/// A store item carries `username`; an item keytar wrote does not.
fn written_by_keytar(item: &Item<'_>, account: &str) -> Result<bool, SsError> {
    Ok(item.get_attributes()?.get("username").map(String::as_str) != Some(account))
}

/// Deletes an item, unlocking it first: the service prompts once for a locked collection.
fn delete(item: &Item<'_>) -> Result<(), SsError> {
    item.unlock()?;
    item.delete()
}

/// Asked when the store found no item: the secret keytar stored, `None` when there is none.
pub fn check(
    session: &Session,
    service: &str,
    account: &str,
) -> keyring_core::Result<Option<Vec<u8>>> {
    session.run(|ss| {
        let items = keytar_items(ss, service, account)?;
        let Some(item) = items.first() else {
            return Ok(None);
        };
        // A locked item is unlocked here: the service prompts the user once for its collection.
        item.unlock()?;
        item.get_secret().map(Some)
    })
}

pub fn after_set(
    session: &Session,
    entry: &Entry,
    service: &str,
    account: &str,
) -> keyring_core::Result<()> {
    entry.update_attributes(&HashMap::from([("account", account)]))?;
    session.run(|ss| {
        let found = ss.search_items(HashMap::from([("service", service), ("account", account)]))?;
        for item in found.unlocked.iter().chain(&found.locked) {
            if written_by_keytar(item, account)? {
                delete(item)?;
            }
        }
        Ok(())
    })
}

pub fn after_delete(session: &Session, service: &str, account: &str) -> keyring_core::Result<()> {
    session.run(|ss| {
        for item in keytar_items(ss, service, account)? {
            delete(&item)?;
        }
        Ok(())
    })
}

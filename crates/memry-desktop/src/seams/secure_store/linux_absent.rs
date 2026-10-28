//! Linux: the items Electron's keytar wrote, and what "no entry" has to rule out.
//!
//! The zbus store finds an item by the attributes `service` and `username`. Electron's keytar
//! wrote and reads `service` and `account` (`keytar_posix.cc`), and libsecret adds
//! `xdg:schema = org.freedesktop.Secret.Generic` to each of its lookups and writes, because
//! keytar's schema does not set `SECRET_SCHEMA_DONT_MATCH_NAME`. So that exactly one item answers
//! for a (service, account) pair after any write, and both apps see it:
//!
//! - **get** ([`check`], when the store found nothing): a search for `service` + `account`. A hit
//!   is the secret.
//! - **set** ([`after_set`]): the store's item gets keytar's `account` and `xdg:schema`
//!   attributes too, then every other item with keytar's attributes is deleted, so the Electron
//!   app reads the new value and no stale secret stays. When the Electron app writes later, its
//!   replace lands on that same item. Both steps are best effort once the value is stored: a
//!   failure is logged and the write still succeeds, because every read of this app finds its own
//!   item first. Until this app's next write repairs it, the Electron app sees the old value: if
//!   the tag failed (or the app stopped before it), keytar finds only its old item; if the tag
//!   landed and the purge failed, two tagged items answer keytar's lookup and libsecret returns
//!   whichever the service lists first. Only the next write of this app tags and purges again.
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
//! cannot take "absent" as proof that it does not: a key minted then sits beside the hidden item,
//! seen with a KeePassXC or KWallet setup whose second database stays locked.
//!
//! The Secret Service connection is kept between calls. A call that fails on the kept connection
//! for a reason other than a lock or a prompt (the keyring daemon restarted, and its session is
//! gone) runs once more on a new one. Nothing here creates a collection.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use keyring_core::{Entry, Error};
use secret_service::blocking::{Item, SecretService};
use secret_service::{EncryptionType, Error as SsError};

/// The schema name libsecret adds for keytar's schema.
const KEYTAR_SCHEMA: &str = "org.freedesktop.Secret.Generic";

/// The default collection: where keytar and this store both write. When the service has none,
/// any locked collection counts.
const DEFAULT_ALIAS: &str = "default";

fn unreachable(error: SsError) -> Error {
    Error::NoStorageAccess(Box::new(error))
}

/// The Secret Service connection of the keyring thread, kept between calls.
#[derive(Default)]
pub struct Session(Mutex<Option<SecretService<'static>>>);

/// A failure of the connection or the session, not an answer about the keyring's contents.
fn stale(error: &SsError) -> bool {
    !matches!(
        error,
        SsError::Locked | SsError::NoResult | SsError::Prompt | SsError::PromptDisconnected
    )
}

impl Session {
    fn run<T>(
        &self,
        work: impl for<'s> Fn(&'s SecretService<'s>) -> Result<T, SsError>,
    ) -> keyring_core::Result<T> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let connect = || SecretService::connect(EncryptionType::Dh).map_err(unreachable);
        let (ss, outcome) = match slot.take() {
            Some(kept) => match work(&kept) {
                Err(error) if stale(&error) => {
                    drop(kept);
                    let fresh = connect()?;
                    let outcome = work(&fresh);
                    (fresh, outcome)
                }
                outcome => (kept, outcome),
            },
            None => {
                let fresh = connect()?;
                let outcome = work(&fresh);
                (fresh, outcome)
            }
        };
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

/// The service prompts once for a locked collection.
fn unlock_if_locked(item: &Item<'_>) -> Result<(), SsError> {
    if item.is_locked()? {
        item.unlock()?;
    }
    Ok(())
}

fn delete(item: &Item<'_>) -> Result<(), SsError> {
    unlock_if_locked(item)?;
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
        unlock_if_locked(item)?;
        item.get_secret().map(Some)
    })
}

/// Runs once the value is stored, so it is best effort: a failure is logged and the write stands.
/// The purge runs only after the tag landed, or the Electron app would find no item at all.
pub fn after_set(session: &Session, entry: &Entry, service: &str, account: &str) {
    let tagged = entry.update_attributes(&HashMap::from([
        ("account", account),
        ("xdg:schema", KEYTAR_SCHEMA),
    ]));
    let purged = tagged.and_then(|()| {
        session.run(|ss| {
            let found =
                ss.search_items(HashMap::from([("service", service), ("account", account)]))?;
            for item in found.unlocked.iter().chain(&found.locked) {
                if written_by_keytar(item, account)? {
                    delete(item)?;
                }
            }
            Ok(())
        })
    });
    if let Err(error) = purged {
        tracing::warn!(
            scope = "Keychain",
            service,
            account,
            "the secret was stored, but the copy the Electron app reads was not updated: {error}"
        );
    }
}

pub fn after_delete(session: &Session, service: &str, account: &str) -> keyring_core::Result<()> {
    session.run(|ss| {
        for item in keytar_items(ss, service, account)? {
            delete(&item)?;
        }
        Ok(())
    })
}

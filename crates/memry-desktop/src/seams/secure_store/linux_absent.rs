//! Linux: what "no entry" has to rule out, and whether the system has a Secret Service at all.
//!
//! A locked default collection hides its items from a search (a cold gnome-keyring shows only
//! hashed attributes; KeePassXC and KWallet behave alike), so the store's "found nothing" proves
//! nothing while it is locked. [`confirm_absent`] then answers `NoStorageAccess`, which the store
//! maps to `Locked`: a read is never "absent" and a delete never reports success over an item it
//! could not see.
//!
//! **Accepted residual.** Only the default collection's lock counts (every collection's when the
//! service has no default alias). An item in another collection that is locked (the user moved
//! the default alias after this app wrote it) is not seen, and a read answers "absent". Counting
//! every collection would answer `Locked` for every absent token while some unrelated keyring
//! stays locked, with nothing that prompts the user to fix it. A caller that knows its secret
//! must exist cannot take "absent" as proof that it does not: a key minted then sits beside the
//! hidden item, seen with a KeePassXC or KWallet setup whose second database stays locked.
//!
//! The Secret Service connection is kept between calls. A call that fails on the kept connection
//! for a reason other than a lock or a prompt (the keyring daemon restarted, and its session is
//! gone) runs once more on a new one. Nothing here creates a collection.

use std::sync::{Mutex, PoisonError};

use keyring_core::Error;
use secret_service::blocking::SecretService;
use secret_service::{EncryptionType, Error as SsError};

/// The default collection, where the store writes. When the service has none, any locked
/// collection counts.
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

/// Asked when the store found no item: `Ok` when nothing can hide one, `NoStorageAccess` while
/// the default collection is locked.
pub fn confirm_absent(session: &Session) -> keyring_core::Result<()> {
    session.run(|ss| {
        if default_collection_is_locked(ss)? {
            return Err(SsError::Locked);
        }
        Ok(())
    })
}

/// The Secret Service's bus name.
const SECRETS_NAME: &str = "org.freedesktop.secrets";

static PROBE: Mutex<super::probe::ProbeState> = Mutex::new(super::probe::ProbeState::Idle);

/// Whether this session has no Secret Service at all: no session bus, or the name is neither
/// owned nor activatable. Any doubt is "one may exist" (see [`super::probe`]).
pub fn service_absent(deadline: std::time::Duration) -> bool {
    super::probe::absent(&PROBE, deadline, probe)
}

fn probe() -> Option<bool> {
    let Ok(connection) = zbus::blocking::Connection::session() else {
        // No bus answered. That proves there is none only when no address was given: zbus then
        // tried the default socket of the session. A given address that fails is a doubt. This
        // is the bus address zbus itself reads, not a launch switch of `LaunchEnv`.
        return std::env::var_os("DBUS_SESSION_BUS_ADDRESS")
            .is_none()
            .then_some(true);
    };
    let bus = zbus::blocking::fdo::DBusProxy::new(&connection).ok()?;
    let name = zbus::names::BusName::try_from(SECRETS_NAME).ok()?;
    if bus.name_has_owner(name).ok()? {
        return Some(false);
    }
    let activatable = bus.list_activatable_names().ok()?;
    Some(!activatable.iter().any(|name| name.as_str() == SECRETS_NAME))
}

//! The OS credential store behind the worker: one `StoreFactory` per platform, and the one place
//! that turns a (service, account) pair into a keyring-core `Entry`.

use std::collections::HashMap;
use std::sync::Arc;

use keyring_core::{CredentialStore, Entry};

pub type Store = Arc<CredentialStore>;

/// Builds the credential store. Called again after any failure, so a Secret Service that starts
/// after the app is found by the next attempt (it opens its D-Bus session at `Store::new`).
pub trait StoreFactory: Send + Sync + 'static {
    fn build(&self) -> keyring_core::Result<Store>;

    /// Whether an entry needs the explicit Credential Manager `target` (see [`entry`]).
    fn names_target(&self) -> bool {
        false
    }

    /// Asked when a read found no entry, before the store answers "absent". It returns the secret
    /// when the platform holds it where the store did not look, and an error of the "could not
    /// reach" class (mapped to `Locked`) when the item may exist but cannot be seen. The default
    /// trusts the store.
    fn absent_check(
        &self,
        _service: &str,
        _account: &str,
    ) -> keyring_core::Result<Option<Vec<u8>>> {
        Ok(None)
    }

    /// Asked after a write landed in `entry`. Linux tags the item with keytar's attribute and
    /// deletes the item keytar wrote, so exactly one item answers for the pair and the Electron
    /// app reads the new value.
    fn after_set(
        &self,
        _entry: &Entry,
        _service: &str,
        _account: &str,
    ) -> keyring_core::Result<()> {
        Ok(())
    }

    /// Asked after the store deleted its item or found none. Linux deletes the items keytar
    /// wrote too, so the read fallback of [`Self::absent_check`] cannot bring a deleted secret
    /// back.
    fn after_delete(&self, _service: &str, _account: &str) -> keyring_core::Result<()> {
        Ok(())
    }
}

/// The store of the running OS.
#[derive(Default)]
pub struct Native {
    /// The Secret Service connection of the keytar-item checks, kept between calls.
    #[cfg(target_os = "linux")]
    session: super::linux_absent::Session,
}

impl StoreFactory for Native {
    fn names_target(&self) -> bool {
        cfg!(windows)
    }

    #[cfg(target_os = "linux")]
    fn absent_check(&self, service: &str, account: &str) -> keyring_core::Result<Option<Vec<u8>>> {
        super::linux_absent::check(&self.session, service, account)
    }

    #[cfg(target_os = "linux")]
    fn after_set(&self, entry: &Entry, service: &str, account: &str) -> keyring_core::Result<()> {
        super::linux_absent::after_set(&self.session, entry, service, account)
    }

    #[cfg(target_os = "linux")]
    fn after_delete(&self, service: &str, account: &str) -> keyring_core::Result<()> {
        super::linux_absent::after_delete(&self.session, service, account)
    }

    #[cfg(target_os = "macos")]
    fn build(&self) -> keyring_core::Result<Store> {
        apple_native_keyring_store::keychain::Store::new().map(|store| store as Store)
    }

    #[cfg(windows)]
    fn build(&self) -> keyring_core::Result<Store> {
        windows_native_keyring_store::Store::new().map(|store| store as Store)
    }

    #[cfg(target_os = "linux")]
    fn build(&self) -> keyring_core::Result<Store> {
        zbus_secret_service_keyring_store::Store::new().map(|store| store as Store)
    }

    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    fn build(&self) -> keyring_core::Result<Store> {
        Err(keyring_core::Error::NoDefaultStore)
    }
}

/// The entry of `service`/`account`. Windows names the credential `<service>/<account>` (the
/// target keytar used), so an Electron-era item and this one are the same Credential Manager
/// entry; macOS and Linux key on service and account.
pub fn entry(
    store: &Store,
    names_target: bool,
    service: &str,
    account: &str,
) -> keyring_core::Result<Entry> {
    if names_target {
        let target = format!("{service}/{account}");
        store.build(
            service,
            account,
            Some(&HashMap::from([("target", target.as_str())])),
        )
    } else {
        store.build(service, account, None)
    }
}

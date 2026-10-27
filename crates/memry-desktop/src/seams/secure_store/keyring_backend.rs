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
}

/// The store of the running OS.
pub struct Native;

impl StoreFactory for Native {
    fn names_target(&self) -> bool {
        cfg!(windows)
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

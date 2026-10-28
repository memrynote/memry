//! The OS keychain behind the core's `SecureStore` seam.
//!
//! The five sync secrets live under service `com.memry.sync`, in the accounts of
//! `apps/desktop/src/main/crypto/keychain-account.ts`, as the base64 text (standard alphabet,
//! padded) of the key bytes, so a value Electron stored is the same bytes here.
//!
//! **Failures.** An entry the keychain says does not exist is `Ok(None)`. Anything that means the
//! keychain could not be reached (locked, no Secret Service, a denied prompt, a call that did not
//! answer within five seconds) is `SecureStoreError::Locked`, which the core never treats as "no
//! key". There is no file fallback on any OS: on Linux without a Secret Service the app never
//! writes a secret to disk, the rule that made Electron refuse Chromium's `basic_text` backend.
//!
//! **Unknown outcome.** A call that passes its deadline answers `Locked` and the keychain may still
//! finish it later. After `Locked` on a write, read before writing a different value: a key that
//! was minted and written may have landed. If the keychain never answers, every call answers
//! `Locked` until the app restarts; there is no second thread to retry on, because a second call
//! into a wedged D-Bus session or Credential Manager would hang as well.
//!
//! **Consumers.** Step 17 (#3534) turns [`KeyringStore::health`] and [`KeyringStore::subscribe_recovered`]
//! into the `keychain_unavailable` sync status and its retries; Step 19 (#3536) shows the same string
//! when a sign-in write fails.

// The file-backed e2e store is a plaintext secret file: it must never ship.
#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("the `e2e` feature keeps secrets in a plain file and is for debug builds only");

mod account;
mod device_identity;
#[cfg(feature = "e2e")]
mod e2e_file;
mod generic;
mod keyring_backend;
#[cfg(target_os = "linux")]
mod linux_absent;
#[cfg(any(target_os = "linux", test))]
mod probe;
mod worker;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use zeroize::Zeroizing;

pub use account::{IDENTITY_SERVICE, KEYS, SERVICE, STORE_KEYS, account};
pub use device_identity::{
    DeviceIdentityStore, device_identity_missing, is_device_identity_missing,
};
pub use generic::GenericSecrets;
pub use keyring_backend::{Native, Store, StoreFactory};
/// The Linux absent-check on its own, for the live test of a locked keyring (the store's search
/// would wait for an unlock prompt first).
#[cfg(all(target_os = "linux", feature = "live-os-secrets"))]
#[doc(hidden)]
pub fn linux_absent_check(service: &str, account: &str) -> keyring_core::Result<Option<Vec<u8>>> {
    linux_absent::check(&linux_absent::Session::default(), service, account)
}
pub use worker::DEADLINE;

/// Whether this system has no keychain at all, so a device key may live in a file
/// ([`DeviceIdentityStore`]). Only Linux can answer yes: no session bus, or no Secret Service
/// running or activatable. A locked keyring, an unanswered prompt or any doubt is "no".
pub fn keychain_absent() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux_absent::service_absent(DEADLINE)
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}
use worker::{Op, Worker};

use crate::e2e::E2eGate;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecureStoreHealth {
    Ready,
    /// The last call could not reach the keychain, or one is still waiting for it.
    Unavailable,
}

pub struct KeyringStore {
    worker: Worker,
    device_suffix: Option<String>,
}

impl KeyringStore {
    /// The keychain of the running OS. `device_suffix` is the `MEMRY_DEVICE` value. An e2e build
    /// whose gate is open keeps its secrets in a file under `e2e_data_dir` instead, so a headless
    /// CI box with no keyring never hangs (Electron bounded each call to 400 ms under test) and a
    /// restart of the same e2e profile keeps its keys, as the Electron e2e run's persistent
    /// staging profile does. A release build links none of it.
    pub fn new(
        device_suffix: Option<String>,
        gate: E2eGate,
        e2e_data_dir: &std::path::Path,
    ) -> Self {
        #[cfg(feature = "e2e")]
        if gate.is_open() {
            return Self::with_factory(
                e2e_file::FileStore::new(e2e_data_dir),
                device_suffix,
                DEADLINE,
            );
        }
        let _ = (gate, e2e_data_dir);
        Self::with_factory(Native::default(), device_suffix, DEADLINE)
    }

    /// A store over any credential store, and a chosen deadline. For tests and the e2e variant.
    #[doc(hidden)]
    pub fn with_factory(
        factory: impl StoreFactory,
        device_suffix: Option<String>,
        deadline: Duration,
    ) -> Self {
        Self {
            worker: Worker::start(factory, deadline),
            device_suffix,
        }
    }

    pub fn health(&self) -> SecureStoreHealth {
        if self.worker.is_unavailable() {
            SecureStoreHealth::Unavailable
        } else {
            SecureStoreHealth::Ready
        }
    }

    /// `listener` runs once each time the keychain goes from unreachable (a call passed its
    /// deadline, or the last call answered `Locked`) to answering, on a short-lived thread of its
    /// own, so it may call this store.
    pub fn subscribe_recovered(&self, listener: impl Fn() + Send + Sync + 'static) {
        self.worker.on_recovered(Arc::new(listener));
    }

    fn account(&self, key: SecureStoreKey) -> Result<String, SecureStoreError> {
        if key == SecureStoreKey::DeviceSigningKey {
            return Err(SecureStoreError::Denied {
                what: "the device signing key is kept by the device identity store".to_owned(),
            });
        }
        Ok(account(key, self.device_suffix.as_deref()))
    }

    /// The account of this device's signing key under [`IDENTITY_SERVICE`].
    pub(crate) fn identity_account(&self) -> String {
        account(
            SecureStoreKey::DeviceSigningKey,
            self.device_suffix.as_deref(),
        )
    }
}

fn failed(what: &str) -> SecureStoreError {
    SecureStoreError::Failed {
        what: what.to_owned(),
    }
}

/// The longest stored text read back. The five real values are at most 90 bytes; the cap keeps a
/// planted oversized item from being decoded.
const MAX_STORED_TEXT: usize = 4096;

fn decode(text: &[u8]) -> Result<Vec<u8>, SecureStoreError> {
    if text.len() > MAX_STORED_TEXT {
        return Err(failed("the stored secret is too long"));
    }
    let text = std::str::from_utf8(text).map_err(|_| failed("the stored secret is not text"))?;
    STANDARD
        .decode(text)
        .map_err(|_| failed("the stored secret is not valid base64"))
}

impl SecureStore for KeyringStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        match self.worker.call(SERVICE, &self.account(key)?, Op::Get)? {
            Some(text) => decode(&text).map(Some),
            None => Ok(None),
        }
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        let value = Zeroizing::new(value);
        let text = Zeroizing::new(STANDARD.encode(value.as_slice()).into_bytes());
        self.worker
            .call(SERVICE, &self.account(key)?, Op::Set(text))
            .map(|_| ())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.worker
            .call(SERVICE, &self.account(key)?, Op::Delete)
            .map(|_| ())
    }

    /// Removes the four entries this store serves, one after another. A failure on one does not
    /// stop the rest; the first failure is returned. Electron's device key item is never touched.
    fn clear(&self) -> Result<(), SecureStoreError> {
        let mut first = Ok(());
        for key in STORE_KEYS {
            if let Err(error) = self.delete(key) {
                first = first.and(Err(error));
            }
        }
        first
    }
}

#[cfg(test)]
mod tests;

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

mod account;
mod generic;
mod keyring_backend;
mod worker;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use zeroize::Zeroizing;

pub use account::{KEYS, SERVICE, account};
pub use generic::GenericSecrets;
pub use keyring_backend::{Native, Store, StoreFactory};
pub use worker::DEADLINE;
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
    /// whose gate is open uses an in-memory store, so a headless CI box with no keyring never
    /// hangs (Electron bounded each call to 400 ms under test); a release build links none of it.
    pub fn new(device_suffix: Option<String>, gate: E2eGate) -> Self {
        #[cfg(feature = "e2e")]
        if gate.is_open() {
            return Self::with_factory(memory::InMemory::new(), device_suffix, DEADLINE);
        }
        let _ = gate;
        Self::with_factory(Native, device_suffix, DEADLINE)
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

    fn account(&self, key: SecureStoreKey) -> String {
        account(key, self.device_suffix.as_deref())
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
        match self.worker.call(SERVICE, &self.account(key), Op::Get)? {
            Some(text) => decode(&text).map(Some),
            None => Ok(None),
        }
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        let value = Zeroizing::new(value);
        let text = Zeroizing::new(STANDARD.encode(value.as_slice()).into_bytes());
        self.worker
            .call(SERVICE, &self.account(key), Op::Set(text))
            .map(|_| ())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.worker
            .call(SERVICE, &self.account(key), Op::Delete)
            .map(|_| ())
    }

    /// Removes all five entries, one after another. A failure on one does not stop the rest;
    /// the first failure is returned.
    fn clear(&self) -> Result<(), SecureStoreError> {
        let mut first = Ok(());
        for key in KEYS {
            if let Err(error) = self.delete(key) {
                first = first.and(Err(error));
            }
        }
        first
    }
}

#[cfg(feature = "e2e")]
mod memory {
    use super::{Store, StoreFactory};

    /// One in-memory credential store for the life of the process.
    pub struct InMemory(Store);

    impl InMemory {
        pub fn new() -> Self {
            Self(keyring_core::mock::Store::new().expect("the mock store always builds"))
        }
    }

    impl StoreFactory for InMemory {
        fn build(&self) -> keyring_core::Result<Store> {
            Ok(self.0.clone())
        }
    }
}

#[cfg(test)]
mod tests;

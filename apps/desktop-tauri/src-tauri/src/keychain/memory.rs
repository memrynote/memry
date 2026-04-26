//! Process-local in-memory `KeychainStore` used in tests and for cfg(test)
//! wiring of `AppState`. The backing map is keyed by `(service, account)`
//! and stores owned `Vec<u8>` payloads. Reads return cloned bytes so callers
//! cannot mutate the store through the returned vector.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::AppResult;
use crate::keychain::service::KeychainStore;

#[derive(Default)]
pub struct MemoryKeychain {
    inner: Mutex<HashMap<(String, String), Vec<u8>>>,
}

impl MemoryKeychain {
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeychainStore for MemoryKeychain {
    fn set_item(&self, service: &str, account: &str, value: &[u8]) -> AppResult<()> {
        let mut guard = self.inner.lock()?;
        guard.insert((service.to_owned(), account.to_owned()), value.to_vec());
        Ok(())
    }

    fn get_item(&self, service: &str, account: &str) -> AppResult<Option<Vec<u8>>> {
        let guard = self.inner.lock()?;
        Ok(guard
            .get(&(service.to_owned(), account.to_owned()))
            .cloned())
    }

    fn delete_item(&self, service: &str, account: &str) -> AppResult<()> {
        let mut guard = self.inner.lock()?;
        guard.remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}

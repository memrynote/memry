//! An API key in the OS keychain, read once and kept in memory until a write. The inline AI and
//! local provider stores share it. One lock covers the cache and every keychain call that fills
//! or changes it, so a read that misses the cache can never put back a key that a racing write
//! just replaced.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use memry_core::api::errors::SecureStoreError;
use zeroize::Zeroizing;

use crate::seams::secure_store::GenericSecrets;

type Cached = Option<(String, Option<Zeroizing<String>>)>;

pub struct CachedKey {
    secrets: Arc<dyn GenericSecrets>,
    service: &'static str,
    /// What the key is, for the error about a stored value that is not text.
    label: &'static str,
    /// The account last read or written, with its key.
    cache: Mutex<Cached>,
}

impl CachedKey {
    pub fn new(
        secrets: Arc<dyn GenericSecrets>,
        service: &'static str,
        label: &'static str,
    ) -> Self {
        Self {
            secrets,
            service,
            label,
            cache: Mutex::new(None),
        }
    }

    /// The key of `account`: the cached one, else the keychain's.
    pub fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, SecureStoreError> {
        let mut cache = self.lock();
        if let Some((cached, key)) = cache.as_ref()
            && cached == account
        {
            return Ok(key.clone());
        }
        let key = match self.secrets.get_secret(self.service, account)? {
            Some(bytes) => {
                let bytes = Zeroizing::new(bytes);
                let text = std::str::from_utf8(&bytes).map_err(|_| SecureStoreError::Failed {
                    what: format!("the stored {} is not UTF-8 text", self.label),
                })?;
                Some(Zeroizing::new(text.to_owned()))
            }
            None => None,
        };
        *cache = Some((account.to_owned(), key.clone()));
        Ok(key)
    }

    /// Stores `key` for `account` (`None` deletes it) and caches it. A keychain failure leaves
    /// the cache as it was.
    pub fn set(
        &self,
        account: &str,
        key: Option<Zeroizing<String>>,
    ) -> Result<(), SecureStoreError> {
        let mut cache = self.lock();
        match &key {
            Some(key) => self
                .secrets
                .set_secret(self.service, account, key.as_bytes())?,
            None => self.secrets.delete_secret(self.service, account)?,
        }
        *cache = Some((account.to_owned(), key));
        Ok(())
    }

    /// Caches `key` for `account`, for a caller that wrote and checked the keychain itself.
    pub fn remember(&self, account: &str, key: Option<Zeroizing<String>>) {
        *self.lock() = Some((account.to_owned(), key));
    }

    pub fn forget(&self) {
        *self.lock() = None;
    }

    fn lock(&self) -> MutexGuard<'_, Cached> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

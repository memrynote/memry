//! A per-call timeout with a latch around a blocking OS key source, like
//! `KEYCHAIN_READ_TIMEOUT_MS` in `secret-storage.ts`.
//!
//! A Keychain, DPAPI or Secret Service call can block on a prompt nobody answers. The call runs
//! on its own thread and the caller waits at most `timeout`. A call that timed out keeps running
//! and holds the latch: further calls fail at once instead of piling prompts on top of it, and
//! the latch lifts when the stuck call returns.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use zeroize::Zeroizing;

use super::key_source::{ChromiumKeySource, KeySourceError};
use super::keytar::{KeytarItem, KeytarSource};
use crate::electron_import::ImportError;
use crate::electron_import::profile::ElectronProfile;

/// The per-call budget of the Electron app (`KEYCHAIN_READ_TIMEOUT_MS`).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Guarded<T> {
    inner: Arc<T>,
    timeout: Duration,
    busy: Arc<AtomicBool>,
}

impl<T: Send + Sync + 'static> Guarded<T> {
    pub fn new(inner: T) -> Self {
        Self::with_timeout(inner, DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(inner: T, timeout: Duration) -> Self {
        Self {
            inner: Arc::new(inner),
            timeout,
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    fn run<R: Send + 'static>(
        &self,
        timed_out: impl FnOnce(String) -> R,
        call: impl FnOnce(&T) -> R + Send + 'static,
    ) -> R {
        if self.busy.swap(true, Ordering::SeqCst) {
            return timed_out("a previous call is still pending".into());
        }
        let (tx, rx) = mpsc::channel();
        let inner = Arc::clone(&self.inner);
        let busy = Arc::clone(&self.busy);
        std::thread::spawn(move || {
            let result = call(&inner);
            busy.store(false, Ordering::SeqCst);
            // The receiver is gone after a timeout; the result is dropped (and zeroized).
            let _ = tx.send(result);
        });
        match rx.recv_timeout(self.timeout) {
            Ok(result) => result,
            Err(_) => timed_out(format!("timed out after {:?}", self.timeout)),
        }
    }
}

impl<T: ChromiumKeySource + Send + Sync + 'static> ChromiumKeySource for Guarded<T> {
    fn password(&self, app_name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeySourceError> {
        let name = app_name.to_owned();
        self.run(
            |why| Err(KeySourceError::Failed(why)),
            move |inner| inner.password(&name),
        )
    }

    fn windows_key(
        &self,
        profile: &ElectronProfile,
    ) -> Result<Option<Zeroizing<[u8; 32]>>, KeySourceError> {
        let profile = profile.clone();
        self.run(
            |why| Err(KeySourceError::Failed(why)),
            move |inner| inner.windows_key(&profile),
        )
    }
}

impl<T: KeytarSource + Send + Sync + 'static> KeytarSource for Guarded<T> {
    fn items(&self) -> Result<Vec<KeytarItem>, ImportError> {
        self.run(
            |why| Err(ImportError::KeySource(why)),
            |inner| inner.items(),
        )
    }
}

#[cfg(test)]
mod tests;

//! A per-call timeout with a latch around a blocking OS key source, like
//! `KEYCHAIN_READ_TIMEOUT_MS` in `secret-storage.ts`.
//!
//! A Keychain, DPAPI or Secret Service call can block on a prompt nobody answers. The call runs
//! on its own thread and the caller waits at most `timeout`. A call that timed out keeps running
//! and holds the latch: further calls fail at once instead of piling prompts on top of it, and
//! the latch lifts when the stuck call returns (or panics: a drop guard releases it).
//!
//! The latch only keeps prompts from stacking within one `Guarded`, so a process builds one
//! instance per kind of source (key source, keytar) and shares it for every read.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use zeroize::Zeroizing;

use super::key_source::{ChromiumKeySource, KeySourceError};
use super::keytar::KeytarSource;
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

    /// Runs `call` on its own thread. Every way it can fail to produce a value (timeout, latch,
    /// panic, no thread) goes through `failed` with a message, so none reads as "missing".
    fn run<R: Send + 'static>(
        &self,
        failed: impl FnOnce(String) -> R,
        call: impl FnOnce(&T) -> R + Send + 'static,
    ) -> R {
        if self.busy.swap(true, Ordering::SeqCst) {
            return failed("a previous call is still pending".into());
        }
        let (tx, rx) = mpsc::channel();
        let inner = Arc::clone(&self.inner);
        let release = Release(Arc::clone(&self.busy));
        let spawned = std::thread::Builder::new()
            .name("electron-import-key-source".into())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| call(&inner)));
                // Lift the latch before the caller can see the result, so the next call never
                // races a worker that has already finished.
                drop(release);
                // The receiver is gone after a timeout; the result is dropped (and zeroized).
                let _ = tx.send(result.map_err(|_| ()));
            });
        if let Err(error) = spawned {
            // The closure, and the guard it owned, were dropped: the latch is free again.
            return failed(format!("could not start a worker thread: {error}"));
        }
        match rx.recv_timeout(self.timeout) {
            Ok(Ok(result)) => result,
            Ok(Err(())) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                failed("the call panicked".into())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                failed(format!("timed out after {:?}", self.timeout))
            }
        }
    }
}

/// Lifts the latch when the worker ends, however it ends.
struct Release(Arc<AtomicBool>);

impl Drop for Release {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
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
    fn list(&self) -> Result<Vec<(String, String)>, KeySourceError> {
        self.run(|why| Err(KeySourceError::Failed(why)), |inner| inner.list())
    }

    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, KeySourceError> {
        let (service, account) = (service.to_owned(), account.to_owned());
        self.run(
            |why| Err(KeySourceError::Failed(why)),
            move |inner| inner.read(&service, &account),
        )
    }
}

#[cfg(test)]
mod tests;

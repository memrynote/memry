//! The roots the pin check verifies a path against: the ones the platform verifier trusts.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use rustls::RootCertStore;
use rustls::pki_types::{CertificateDer, TrustAnchor};

type Roots = Arc<Vec<TrustAnchor<'static>>>;

/// A path that does not verify reads the OS store again at most this often.
const RELOAD_EVERY: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct NativeRoots {
    roots: Option<Roots>,
    reloaded_at: Option<Instant>,
}

pub enum Anchors {
    /// The OS trust store, read on the first pinned handshake and again when a path does not
    /// verify against it (Windows installs a root the first time a chain needs it), at most once
    /// per [`RELOAD_EVERY`]. The read runs on the handshake's thread, a Tokio worker: a one-time
    /// stall of the time the OS takes to list its roots, on the first request to a pinned host.
    Native(Mutex<NativeRoots>),
    /// A test's own roots.
    Fixed(Roots),
}

impl Anchors {
    pub fn native() -> Self {
        Self::Native(Mutex::default())
    }

    pub fn fixed(roots: &[&CertificateDer<'_>]) -> Self {
        let mut store = RootCertStore::empty();
        for root in roots {
            if let Err(error) = store.add((*root).clone().into_owned()) {
                tracing::warn!(scope = "Pinning", "a test root was refused: {error}");
            }
        }
        Self::Fixed(Arc::new(store.roots))
    }

    /// The roots, read from the OS on first use.
    pub fn roots(&self) -> Roots {
        match self {
            Self::Fixed(roots) => roots.clone(),
            Self::Native(native) => native
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .roots
                .get_or_insert_with(load_native)
                .clone(),
        }
    }

    /// The OS trust store read again; `None` for fixed roots and within [`RELOAD_EVERY`] of the
    /// last reload.
    pub(super) fn reload(&self) -> Option<Roots> {
        let Self::Native(native) = self else {
            return None;
        };
        let mut native = native.lock().unwrap_or_else(PoisonError::into_inner);
        if native
            .reloaded_at
            .is_some_and(|at| at.elapsed() < RELOAD_EVERY)
        {
            return None;
        }
        let fresh = load_native();
        native.roots = Some(fresh.clone());
        native.reloaded_at = Some(Instant::now());
        Some(fresh)
    }
}

fn load_native() -> Roots {
    let result = rustls_native_certs::load_native_certs();
    for error in &result.errors {
        tracing::warn!(scope = "Pinning", "an OS root could not be read: {error}");
    }
    let mut store = RootCertStore::empty();
    let (added, ignored) = store.add_parsable_certificates(result.certs);
    if ignored > 0 {
        tracing::debug!(scope = "Pinning", "{ignored} OS roots could not be parsed");
    }
    if added == 0 {
        tracing::error!(
            scope = "Pinning",
            "no OS root was readable; pinned hosts will be refused"
        );
    }
    Arc::new(store.roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_os_store_is_read_again_at_most_once_a_minute() {
        let anchors = Anchors::native();
        assert!(anchors.reload().is_some());
        assert!(anchors.reload().is_none());
        assert!(Anchors::fixed(&[]).reload().is_none());
    }
}

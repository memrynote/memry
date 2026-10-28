//! The roots the pin check verifies a path against: the ones the platform verifier trusts.

use std::sync::{Arc, Mutex, PoisonError};

use rustls::RootCertStore;
use rustls::pki_types::{CertificateDer, TrustAnchor};

type Roots = Arc<Vec<TrustAnchor<'static>>>;

pub enum Anchors {
    /// The OS trust store, read on the first pinned handshake and again when a path does not
    /// verify against it (Windows installs a root the first time a chain needs it).
    Native(Mutex<Option<Roots>>),
    /// A test's own roots.
    Fixed(Roots),
}

impl Anchors {
    pub fn native() -> Self {
        Self::Native(Mutex::new(None))
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
            Self::Native(cache) => cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_or_insert_with(load_native)
                .clone(),
        }
    }

    /// The OS trust store read again; `None` for fixed roots.
    pub(super) fn reload(&self) -> Option<Roots> {
        match self {
            Self::Fixed(_) => None,
            Self::Native(cache) => {
                let fresh = load_native();
                *cache.lock().unwrap_or_else(PoisonError::into_inner) = Some(fresh.clone());
                Some(fresh)
            }
        }
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

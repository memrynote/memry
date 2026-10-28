//! Certificate pinning for the sync host.
//!
//! One `rustls::ClientConfig` per transport: the platform verifier (OS trust store, hostname,
//! revocation as the OS does it) wrapped by [`PinningVerifier`]. The pin table keeps Electron's
//! contract (`apps/desktop/src/main/sync/certificate-pinning.ts`): a host with placeholder pins or
//! no entry gets standard TLS, and pinning is off in a debug build. Unlike Electron, which compared
//! the leaf only, a pin on any certificate of the leaf's issuance path matches, so a pin on an
//! intermediate survives leaf rotation. A root is never presented and cannot be pinned.
//!
//! **Rotation.** A pin that names a CA's intermediate stops matching the day the host's CA changes
//! it (a CDN may switch issuers without notice), and every installed build then refuses to sync.
//! Ship two pins at least: the current path and a backup from another issuer.

pub mod pins;
pub mod spki;
mod verifier;

use std::sync::Arc;

use memry_core::api::errors::TransportError;
use rustls::ClientConfig;
use rustls::client::danger::ServerCertVerifier;

pub use pins::PinTable;
pub use verifier::{PinFailure, PinFailureSink, PinningVerifier};

/// What a `ClientConfig` is built from. Production uses [`TlsSetup::platform`]; a test passes its
/// own inner verifier, pin table and activity.
pub struct TlsSetup {
    pub inner: Arc<dyn ServerCertVerifier>,
    pub table: PinTable,
    pub active: bool,
}

impl TlsSetup {
    /// The OS trust store and the production table, pinning active in a release build.
    pub fn platform() -> Result<Self, TransportError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let inner = rustls_platform_verifier::Verifier::new(provider).map_err(|error| {
            TransportError::Failed {
                what: format!("could not start the platform certificate verifier: {error}"),
            }
        })?;
        Ok(Self {
            inner: Arc::new(inner),
            table: PinTable::production(),
            active: !cfg!(debug_assertions),
        })
    }

    pub fn client_config(
        self,
        sink: Arc<dyn PinFailureSink>,
    ) -> Result<ClientConfig, TransportError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = PinningVerifier::new(self.inner, self.table, self.active, sink);
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| TransportError::Failed {
                what: format!("could not build the TLS configuration: {error}"),
            })?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        Ok(config)
    }
}

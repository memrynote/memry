//! `PinningVerifier`: the OS trust store and hostname check first, then the pins.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, SignatureScheme};

use super::pins::{PinPolicy, PinTable};
use super::spki::issuance_path_pins;

/// A pinned host answered with a chain none of whose issuance-path certificates is pinned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinFailure {
    pub hostname: String,
    /// The pin of the leaf the server presented.
    pub actual_hash: String,
    pub expected_hashes: Vec<String>,
}

/// Told once per mismatch. Step 17 (#3534) turns it into the `certificate_pin_failed` event.
pub trait PinFailureSink: Send + Sync {
    fn pin_failed(&self, failure: PinFailure);
}

pub struct PinningVerifier {
    inner: Arc<dyn ServerCertVerifier>,
    table: PinTable,
    /// Pinning is off in a debug build, as it was in an Electron app that was not packaged.
    active: bool,
    sink: Arc<dyn PinFailureSink>,
    warned: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for PinningVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PinningVerifier")
            .field("active", &self.active)
            .finish_non_exhaustive()
    }
}

impl PinningVerifier {
    /// `inner` is the platform verifier in the app (a test may pass a verifier over its own CA).
    pub fn new(
        inner: Arc<dyn ServerCertVerifier>,
        table: PinTable,
        active: bool,
        sink: Arc<dyn PinFailureSink>,
    ) -> Self {
        Self {
            inner,
            table,
            active,
            sink,
            warned: Mutex::new(HashSet::new()),
        }
    }

    fn warn_once(&self, key: String, message: impl FnOnce() -> String, loud: bool) {
        let first = self
            .warned
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key);
        if first {
            if loud {
                tracing::warn!(scope = "Pinning", "{}", message());
            } else {
                tracing::debug!(scope = "Pinning", "{}", message());
            }
        }
    }

    fn check_pins(
        &self,
        host: &str,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
    ) -> Result<(), Error> {
        let pins = match self.table.policy(host) {
            PinPolicy::Unlisted => {
                self.warn_once(
                    format!("unlisted {host}"),
                    || format!("no certificate pins for {host}: standard TLS"),
                    true,
                );
                return Ok(());
            }
            PinPolicy::Placeholder => {
                self.warn_once(
                    format!("placeholder {host}"),
                    || format!("certificate pins for {host} are placeholders: standard TLS"),
                    false,
                );
                return Ok(());
            }
            PinPolicy::Pinned(pins) => pins,
        };
        let chain: Vec<&[u8]> = std::iter::once(end_entity.as_ref())
            .chain(intermediates.iter().map(AsRef::as_ref))
            .collect();
        let path = issuance_path_pins(&chain).map_err(|error| {
            tracing::warn!(scope = "Pinning", "{host}: {error}");
            Error::General("certificate chain could not be checked against the pins".to_owned())
        })?;
        if path.iter().any(|actual| pins.contains(actual)) {
            return Ok(());
        }
        self.sink.pin_failed(PinFailure {
            hostname: host.to_owned(),
            actual_hash: path.first().cloned().unwrap_or_default(),
            expected_hashes: pins.to_vec(),
        });
        Err(Error::General("certificate pin mismatch".to_owned()))
    }
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        // The chain and the hostname first: a pin never stands in for either.
        let verified = self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        )?;
        if self.active {
            self.check_pins(&server_name.to_str(), end_entity, intermediates)?;
        }
        Ok(verified)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

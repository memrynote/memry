//! `PinningVerifier`: the OS trust store and hostname check first, then the pins.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, SignatureScheme};

use super::anchors::Anchors;
use super::pins::{PinPolicy, PinTable};
use super::spki::{ChainError, leaf_pin, verified_path_pins};

/// A pinned host's chain was refused by the pin check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinFailure {
    pub hostname: String,
    /// The pin of the leaf the server presented.
    pub actual_hash: String,
    pub expected_hashes: Vec<String>,
    pub reason: PinFailureReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinFailureReason {
    /// Paths to an OS root verified, and none carries a pin: the host presents certificates the
    /// table does not name (a rotation, or an interception).
    Mismatch,
    /// No path to an OS root verified for the pin check, though the platform verifier accepted
    /// the chain: the OS roots this check reads lack the one the platform used, or the server left
    /// out an intermediate the platform fetched. webpki's reason.
    Unverified { what: String },
}

/// Told once per mismatch. Step 17 (#3534) turns it into the `certificate_pin_failed` event.
pub trait PinFailureSink: Send + Sync {
    fn pin_failed(&self, failure: PinFailure);
}

pub struct PinningVerifier {
    inner: Arc<dyn ServerCertVerifier>,
    table: PinTable,
    anchors: Anchors,
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
    /// `inner` is the platform verifier in the app and `anchors` the roots it trusts (a test may
    /// pass a verifier over its own CA, with that CA).
    pub fn new(
        inner: Arc<dyn ServerCertVerifier>,
        table: PinTable,
        anchors: Anchors,
        active: bool,
        sink: Arc<dyn PinFailureSink>,
    ) -> Self {
        Self {
            inner,
            table,
            anchors,
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
        now: UnixTime,
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
        let accept = |path: &[String]| path.iter().any(|pin| pins.contains(pin));
        let verify =
            |anchors: &[_]| verified_path_pins(anchors, end_entity, intermediates, now, &accept);
        let mut result = verify(&self.anchors.roots());
        if matches!(result, Err(ChainError::Unverified(_)))
            && let Some(fresh) = self.anchors.reload()
        {
            result = verify(&fresh);
        }
        let (reason, message) = match result {
            Ok(_) => return Ok(()),
            Err(error @ (ChainError::TooLong | ChainError::TooLarge | ChainError::Malformed)) => {
                tracing::warn!(scope = "Pinning", "{host}: {error}");
                return Err(Error::General(
                    "certificate chain could not be checked against the pins".to_owned(),
                ));
            }
            Err(ChainError::Unverified(what)) => (
                PinFailureReason::Unverified { what },
                "certificate pin check found no verified path",
            ),
            Err(ChainError::NotAccepted) => {
                (PinFailureReason::Mismatch, "certificate pin mismatch")
            }
        };
        tracing::warn!(scope = "Pinning", "{host}: {reason:?}");
        self.sink.pin_failed(PinFailure {
            hostname: host.to_owned(),
            actual_hash: leaf_pin(end_entity).unwrap_or_default(),
            expected_hashes: pins.to_vec(),
            reason,
        });
        Err(Error::General(message.to_owned()))
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
            self.check_pins(&server_name.to_str(), end_entity, intermediates, now)?;
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

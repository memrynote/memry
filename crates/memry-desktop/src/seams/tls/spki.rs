//! The SPKI hashes of the certificates on a presented chain's issuance path.
//!
//! This reads certificates a server sent, so it runs only after the platform verifier accepted the
//! chain, and it is bounded: at most [`MAX_CHAIN`] certificates of at most [`MAX_DER`] bytes each,
//! checked before any parse, and a fixed number of signature checks (at most one per candidate
//! issuer of each certificate on the path).
//!
//! **A pin matches only a certificate on the issuance path** of the leaf: the leaf, its issuer, that
//! issuer's issuer, and so on, each link proven by the signature of the certificate above it. The
//! platform verifier alone is not enough: the pinned intermediate of a host is public, so an
//! attacker holding a leaf misissued by another trusted CA could append that intermediate to the
//! chain it presents, and a check for "any presented certificate has a pinned SPKI" would pass.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};
use x509_parser::certificate::X509Certificate;
use x509_parser::prelude::FromDer;

use super::pins::PIN_PREFIX;

/// A real chain has three or four certificates.
pub const MAX_CHAIN: usize = 8;
/// A real certificate is under 6 KiB.
pub const MAX_DER: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainError {
    TooLong,
    TooLarge,
    Malformed,
}

impl std::fmt::Display for ChainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::TooLong => "the certificate chain is too long",
            Self::TooLarge => "a certificate is too large",
            Self::Malformed => "a certificate could not be read",
        })
    }
}

/// `sha256/<base64>` of the SubjectPublicKeyInfo of one certificate (DER).
pub fn spki_pin(cert: &X509Certificate<'_>) -> String {
    let digest = Sha256::digest(cert.public_key().raw);
    format!("{PIN_PREFIX}{}", STANDARD.encode(digest))
}

/// The pins of the issuance path, leaf first. `chain` is the leaf followed by what the server
/// presented after it, in any order.
pub fn issuance_path_pins(chain: &[&[u8]]) -> Result<Vec<String>, ChainError> {
    if chain.len() > MAX_CHAIN {
        return Err(ChainError::TooLong);
    }
    if chain.iter().any(|der| der.len() > MAX_DER) {
        return Err(ChainError::TooLarge);
    }
    let certs = chain
        .iter()
        .map(|der| match X509Certificate::from_der(der) {
            Ok(([], cert)) => Ok(cert),
            _ => Err(ChainError::Malformed),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some(leaf) = certs.first() else {
        return Err(ChainError::Malformed);
    };

    let mut used = vec![false; certs.len()];
    used[0] = true;
    let mut path = vec![leaf];
    while let Some(&current) = path.last() {
        let issuer = certs.iter().enumerate().find(|(index, candidate)| {
            !used[*index]
                && candidate.subject().as_raw() == current.issuer().as_raw()
                && current
                    .verify_signature(Some(candidate.public_key()))
                    .is_ok()
        });
        let Some((index, issuer)) = issuer else { break };
        used[index] = true;
        path.push(issuer);
    }
    Ok(path.into_iter().map(spki_pin).collect())
}

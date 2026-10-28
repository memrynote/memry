//! The SPKI hashes of a verified path from the presented leaf to a trust anchor.
//!
//! **A pin matches only a certificate on a path webpki verified**: the leaf, each intermediate a
//! valid CA for the certificate below it (basicConstraints `cA`, `keyCertSign`, path length,
//! validity, a signature algorithm rustls accepts), and the trust anchor that ends the path, sent
//! or not. The certificates the server sent are only candidates. A check for "some presented
//! certificate has a pinned SPKI", or a path built from names and signatures alone, accepts a
//! chain an attacker extends: the pinned intermediate is public, and an end-entity certificate it
//! issued can stand where a CA should be. webpki tries every valid path (bounded by its own
//! budget), so a valid path through a pinned certificate is found even when another path is tried
//! first.
//!
//! This reads certificates a server sent, so it runs only after the platform verifier accepted the
//! chain, and the input is bounded before any parse: at most [`MAX_CHAIN`] certificates of at most
//! [`MAX_DER`] bytes each.

use std::cell::{Cell, RefCell};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use rustls::pki_types::{CertificateDer, TrustAnchor, UnixTime};
use sha2::{Digest, Sha256};
use webpki::{EndEntityCert, KeyUsage, VerifiedPath};

use super::pins::PIN_PREFIX;

/// A real chain has three or four certificates.
pub const MAX_CHAIN: usize = 8;
/// A real certificate is under 6 KiB.
pub const MAX_DER: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainError {
    TooLong,
    TooLarge,
    Malformed,
    /// No path from the leaf to a trust anchor verified (webpki's reason).
    Unverified(String),
    /// Paths verified, and none of them was accepted.
    NotAccepted,
}

impl std::fmt::Display for ChainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLong => f.write_str("the certificate chain is too long"),
            Self::TooLarge => f.write_str("a certificate is too large"),
            Self::Malformed => f.write_str("the leaf certificate could not be read"),
            Self::Unverified(reason) => {
                write!(f, "no path to a trusted root verified: {reason}")
            }
            Self::NotAccepted => f.write_str("no verified path carries a pinned certificate"),
        }
    }
}

/// `sha256/<base64>` of a DER SubjectPublicKeyInfo (with its outer `SEQUENCE`).
pub fn pin_of_spki(spki: &[u8]) -> String {
    format!("{PIN_PREFIX}{}", STANDARD.encode(Sha256::digest(spki)))
}

/// A trust anchor keeps its SPKI without the outer `SEQUENCE` header; the pin hashes the whole.
fn pin_of_anchor(anchor: &TrustAnchor<'_>) -> String {
    let content = anchor.subject_public_key_info.as_ref();
    let mut spki = vec![0x30];
    let len = content.len();
    if len < 0x80 {
        spki.push(len as u8);
    } else {
        let bytes: Vec<u8> = len
            .to_be_bytes()
            .into_iter()
            .skip_while(|byte| *byte == 0)
            .collect();
        spki.push(0x80 | bytes.len() as u8);
        spki.extend(bytes);
    }
    spki.extend_from_slice(content);
    pin_of_spki(&spki)
}

fn path_pins(path: &VerifiedPath<'_>) -> Vec<String> {
    let mut pins = vec![pin_of_spki(
        path.end_entity().subject_public_key_info().as_ref(),
    )];
    pins.extend(
        path.intermediate_certificates()
            .map(|cert| pin_of_spki(cert.subject_public_key_info().as_ref())),
    );
    pins.push(pin_of_anchor(path.anchor()));
    pins
}

/// The pins of the first verified path `accept` takes (leaf first, anchor last). `intermediates`
/// is what the server sent after the leaf, in any order.
pub fn verified_path_pins(
    anchors: &[TrustAnchor<'_>],
    end_entity: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    now: UnixTime,
    accept: &dyn Fn(&[String]) -> bool,
) -> Result<Vec<String>, ChainError> {
    if intermediates.len() + 1 > MAX_CHAIN {
        return Err(ChainError::TooLong);
    }
    if std::iter::once(end_entity)
        .chain(intermediates)
        .any(|der| der.len() > MAX_DER)
    {
        return Err(ChainError::TooLarge);
    }
    let leaf = EndEntityCert::try_from(end_entity).map_err(|_| ChainError::Malformed)?;
    let accepted = RefCell::new(None);
    let saw_path = Cell::new(false);
    let check = |path: &VerifiedPath<'_>| {
        saw_path.set(true);
        let pins = path_pins(path);
        if accept(&pins) {
            *accepted.borrow_mut() = Some(pins);
            Ok(())
        } else {
            // Any error makes webpki try the next path.
            Err(webpki::Error::UnknownIssuer)
        }
    };
    let result = leaf.verify_for_usage(
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .all,
        anchors,
        intermediates,
        now,
        KeyUsage::server_auth(),
        None,
        Some(&check),
    );
    match (result, accepted.into_inner()) {
        (Ok(_), Some(pins)) => Ok(pins),
        _ if saw_path.get() => Err(ChainError::NotAccepted),
        (Err(error), _) => Err(ChainError::Unverified(error.to_string())),
        (Ok(_), None) => Err(ChainError::NotAccepted),
    }
}

/// The pin of the leaf alone, for the failure report.
pub fn leaf_pin(end_entity: &CertificateDer<'_>) -> Option<String> {
    let leaf = EndEntityCert::try_from(end_entity).ok()?;
    Some(pin_of_spki(leaf.subject_public_key_info().as_ref()))
}

#[cfg(test)]
mod tests {
    use rustls::pki_types::Der;

    use super::*;

    /// An RSA root's SPKI is longer than 255 bytes, so its `SEQUENCE` length takes the long form.
    #[test]
    fn an_anchor_s_pin_hashes_its_spki_with_the_outer_sequence() {
        for (len, header) in [
            (89_usize, vec![0x30, 89]),
            (294, vec![0x30, 0x82, 0x01, 0x26]),
        ] {
            let content = vec![7_u8; len];
            let anchor = TrustAnchor {
                subject: Der::from_slice(&[]),
                subject_public_key_info: Der::from(content.clone()),
                name_constraints: None,
            };
            let whole = [header, content].concat();
            assert_eq!(pin_of_anchor(&anchor), pin_of_spki(&whole));
        }
    }
}

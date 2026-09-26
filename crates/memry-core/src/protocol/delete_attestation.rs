//! The delete attestation, chapter 04 §4.8.4 (#2408).
//!
//! A tombstone's record signature covers its encrypted payload, and the server
//! sheds that payload after retention (chapter 05 §5.12.3). The attestation is
//! a second, content-free signature by the same device key over
//! `{purpose, id, type, deletedAt, clock}`, which the server keeps with the
//! marker so a purged tombstone stays verifiable.
//!
//! **Signed exactly as pushed.** `deletedAt` is this core's milliseconds and
//! the desktop's seconds; the server stores and serves the pushed value, so
//! the bytes are bound as sent and never normalised. The clock is the rebound,
//! `_offline`-free one [`super::account`] pushes.
//!
//! **Domain separation is structural.** The message always carries `purpose`,
//! which the `SYNC_ITEM` allowlist rejects, and never the payload fields the
//! record signature always carries. `delete-attestation.json` pins the bytes
//! against the TypeScript writer.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use ciborium::value::Value;

use crate::crypto::cbor::{self, field_order};
use crate::crypto::sodium;
use crate::protocol::envelope::{EnvelopeError, SyncOperation};
use crate::protocol::types::{SUBSCRIBED_ITEM_TYPES, UNSUBSCRIBED_RECORD_ITEM_TYPES};
use crate::sync::clock::VectorClock;

/// The literal `purpose` value, versioned so a v2 cannot collide with v1.
pub const PURPOSE: &str = "memry-delete-attestation-v1";

/// The one record type with no required clock, chapter 00 §0.7.
const CLOCK_EXEMPT_ITEM_TYPE: &str = "settings";

/// The facts an attestation signs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleteClaim<'a> {
    pub item_type: &'a str,
    pub item_id: &'a str,
    pub clock: &'a VectorClock,
    pub deleted_at: i64,
}

/// `RECORD_CLOCK_REQUIRED_ITEM_TYPES`: every record type except `settings`.
fn is_clock_required(item_type: &str) -> bool {
    item_type != CLOCK_EXEMPT_ITEM_TYPE
        && (SUBSCRIBED_ITEM_TYPES.contains(&item_type)
            || UNSUBSCRIBED_RECORD_ITEM_TYPES.contains(&item_type))
}

/// The claim a write attests, or `None` when it attests nothing.
///
/// Mirrors `deleteClaimOf` in `packages/contracts/src/delete-attestation.ts`:
/// a delete of a clock-required type with a non-empty clock and a
/// `deletedAt`. Without a pushed `deletedAt` the server stores its own time,
/// which cannot be signed in advance.
pub fn claim_of<'a>(
    item_type: &'a str,
    item_id: &'a str,
    operation: SyncOperation,
    clock: Option<&'a VectorClock>,
    deleted_at: Option<i64>,
) -> Option<DeleteClaim<'a>> {
    if operation != SyncOperation::Delete || !is_clock_required(item_type) {
        return None;
    }
    let clock = clock.filter(|clock| !clock.is_empty())?;
    let deleted_at = deleted_at.filter(|at| *at >= 0)?;
    Some(DeleteClaim {
        item_type,
        item_id,
        clock,
        deleted_at,
    })
}

/// The signed bytes: canonical CBOR under `DELETE_ATTESTATION`.
pub fn message(claim: &DeleteClaim<'_>) -> Result<Vec<u8>, EnvelopeError> {
    let ticks = claim
        .clock
        .iter()
        .map(|(device, tick)| (Value::Text(device.clone()), Value::Integer((*tick).into())))
        .collect();
    let map: cbor::CanonicalMap = vec![
        ("purpose".to_owned(), Value::Text(PURPOSE.to_owned())),
        ("id".to_owned(), Value::Text(claim.item_id.to_owned())),
        ("type".to_owned(), Value::Text(claim.item_type.to_owned())),
        (
            "deletedAt".to_owned(),
            Value::Integer(claim.deleted_at.into()),
        ),
        ("clock".to_owned(), Value::Map(ticks)),
    ];
    Ok(cbor::encode(field_order::DELETE_ATTESTATION, &map)?)
}

/// Signs a claim with this device's Ed25519 secret key; standard base64.
pub fn sign(claim: &DeleteClaim<'_>, signing_secret_key: &[u8]) -> Result<String, EnvelopeError> {
    let signature = sodium::sign_detached(&message(claim)?, signing_secret_key)?;
    Ok(BASE64_STANDARD.encode(signature))
}

/// Verifies an attestation over exactly this claim under the signer's key.
///
/// A signature that is not base64 is `Malformed`; one that does not verify,
/// including one of the wrong length, is `SignatureInvalid`.
pub fn verify(
    claim: &DeleteClaim<'_>,
    signature_b64: &str,
    signer_public_key: &[u8],
) -> Result<(), EnvelopeError> {
    let signature =
        BASE64_STANDARD
            .decode(signature_b64)
            .map_err(|_| EnvelopeError::Malformed {
                what: "deleteAttestation is not base64".to_owned(),
            })?;
    if sodium::sign_verify_detached(&signature, &message(claim)?, signer_public_key) {
        Ok(())
    } else {
        Err(EnvelopeError::SignatureInvalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock() -> VectorClock {
        VectorClock::from([("dev-a".to_owned(), 7), ("dev-b".to_owned(), 3)])
    }

    #[test]
    fn only_an_attestable_delete_has_a_claim() {
        let clock = clock();
        let empty = VectorClock::new();
        let delete = SyncOperation::Delete;
        assert!(claim_of("task", "t", delete, Some(&clock), Some(5)).is_some());
        assert!(claim_of("task", "t", SyncOperation::Update, Some(&clock), Some(5)).is_none());
        assert!(claim_of("settings", "general", delete, Some(&clock), Some(5)).is_none());
        assert!(claim_of("attachment", "a", delete, Some(&clock), Some(5)).is_none());
        assert!(claim_of("task", "t", delete, None, Some(5)).is_none());
        assert!(claim_of("task", "t", delete, Some(&empty), Some(5)).is_none());
        assert!(claim_of("task", "t", delete, Some(&clock), None).is_none());
        assert!(claim_of("task", "t", delete, Some(&clock), Some(-1)).is_none());
    }

    #[test]
    fn a_signature_verifies_only_over_its_own_claim_and_key() {
        let (public, secret) = sodium::sign_seed_keypair(&[9u8; 32]).expect("a keypair");
        let (other, _) = sodium::sign_seed_keypair(&[8u8; 32]).expect("a keypair");
        let clock = clock();
        let claim = claim_of("task", "t", SyncOperation::Delete, Some(&clock), Some(5)).unwrap();
        let signature = sign(&claim, &secret).expect("signs");

        assert!(verify(&claim, &signature, &public).is_ok());
        assert!(verify(&claim, &signature, &other).is_err());
        let later = DeleteClaim {
            deleted_at: 6,
            ..claim
        };
        assert!(verify(&later, &signature, &public).is_err());
        assert!(matches!(
            verify(&claim, "not base64!", &public),
            Err(EnvelopeError::Malformed { .. })
        ));
        assert!(matches!(
            verify(&claim, "AAAA", &public),
            Err(EnvelopeError::SignatureInvalid)
        ));
    }
}

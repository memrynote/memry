//! §3.8's QR payload, and the two checks that precede any crypto.
//!
//! Everything here is pure and runs before a single byte leaves the device.
//! §3.8 requires the scanner to refuse an expired session **before doing any
//! crypto**, and §3.3 requires the decoded `linkingSecret` length check to be
//! the client's, because the server schema is only `z.string().min(1)`.
//!
//! **An unparseable payload never reads as a benign one.** Each refusal is its
//! own variant: a payload that is not JSON, a field that is missing or of the
//! wrong JSON type, a `sessionId` that is not a UUID, and a `linkingSecret`
//! that does not decode to 32 bytes are four different things a user must be
//! told four different things about, and collapsing them into "invalid QR
//! code" is the shape of the incident `protocol::account`'s module doc records.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde_json::Value as Json;

use super::{LinkingError, X25519_KEY_BYTES, check_length, decode_linking_secret};

/// The QR code, parsed. §3.8:
/// `JSON.stringify({ sessionId, ephemeralPublicKey, linkingSecret, expiresAt })`.
///
/// `linking_secret_b64` keeps the **string** the desktop minted, because §3.3
/// requires it echoed back byte-exact in `POST /auth/linking/scan` — the server
/// stores `hex(SHA-256(utf8(string)))` and re-hashes what it is sent, so a
/// client that re-encoded its own decode would fail on any encoder disagreement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkingInvitation {
    pub session_id: String,
    /// The initiator's ephemeral X25519 public key, standard base64.
    pub initiator_public_key_b64: String,
    pub linking_secret_b64: String,
    /// Epoch **seconds**, absolute from `initiate` (§3.4).
    pub expires_at_s: u64,
}

/// Parses and validates the QR payload of §3.8.
///
/// Validation is everything that can be checked without the network: the four
/// fields exist and have the right JSON types, `sessionId` is a UUID (§3.1 —
/// the server validates it as one while the contract says only `min(1)`), the
/// initiator key is a 32-byte point (§3.5), and the secret decodes to exactly
/// 32 bytes (§3.3).
pub fn parse_invitation(payload: &str) -> Result<LinkingInvitation, LinkingError> {
    let json: Json = serde_json::from_str(payload).map_err(|_| LinkingError::InvalidQrPayload {
        what: "not JSON".into(),
    })?;

    let session_id = string_field(&json, "sessionId")?;
    if !is_uuid(&session_id) {
        return Err(LinkingError::InvalidQrPayload {
            what: "sessionId is not a UUID".into(),
        });
    }
    let initiator_public_key_b64 = string_field(&json, "ephemeralPublicKey")?;
    let initiator_public_key = BASE64_STANDARD
        .decode(&initiator_public_key_b64)
        .map_err(|_| LinkingError::InvalidBase64 {
            what: "ephemeralPublicKey".into(),
        })?;
    check_length(
        "ephemeralPublicKey",
        X25519_KEY_BYTES,
        &initiator_public_key,
    )?;

    let linking_secret_b64 = string_field(&json, "linkingSecret")?;
    // §3.3, and the reason this is here rather than at the HMAC: a 31-byte
    // secret is a QR the user should be told to rescan, not a MAC failure the
    // server reports as `LINKING_SECRET_INVALID` after a round trip.
    let _ = decode_linking_secret(&linking_secret_b64)?;

    let expires_at_s = json
        .get("expiresAt")
        .and_then(Json::as_u64)
        .ok_or_else(|| LinkingError::InvalidQrPayload {
            what: "expiresAt is missing or not a whole number of seconds".into(),
        })?;

    Ok(LinkingInvitation {
        session_id,
        initiator_public_key_b64,
        linking_secret_b64,
        expires_at_s,
    })
}

/// §3.4's expiry predicate, as the server evaluates it: `expires_at < now`, so
/// **a request at exactly `expires_at` is still accepted**.
///
/// The server's `expiresAt` is used; §3.4's 300 s is never assumed, because
/// neither `scan` nor `approve` extends the window and only the initiator knows
/// when it opened.
pub fn assert_not_expired(expires_at_s: u64, now_s: u64) -> Result<(), LinkingError> {
    if expires_at_s < now_s {
        return Err(LinkingError::SessionExpired);
    }
    Ok(())
}

fn string_field(json: &Json, name: &str) -> Result<String, LinkingError> {
    json.get(name)
        .and_then(Json::as_str)
        .map(str::to_string)
        .ok_or_else(|| LinkingError::InvalidQrPayload {
            what: format!("{name} is missing or not a string"),
        })
}

/// §3.1: "A conforming client MUST treat it as a UUID." Shape only — the
/// version and variant nibbles are the server's business, and rejecting a
/// well-formed id this client merely does not recognise would be a refusal the
/// user cannot act on.
fn is_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && [8, 4, 4, 4, 12] == groups.iter().map(|g| g.len()).collect::<Vec<_>>()[..]
        && groups
            .iter()
            .all(|g| g.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    fn payload(secret_bytes: usize, expires_at: u64) -> String {
        format!(
            r#"{{"sessionId":"{SESSION}","ephemeralPublicKey":"{}","linkingSecret":"{}","expiresAt":{expires_at}}}"#,
            BASE64_STANDARD.encode([0x22u8; 32]),
            BASE64_STANDARD.encode(vec![0x11u8; secret_bytes]),
        )
    }

    #[test]
    fn the_four_fields_of_section_3_8_are_read() {
        let invitation = parse_invitation(&payload(32, 1_700_000_000)).expect("a payload");
        assert_eq!(invitation.session_id, SESSION);
        assert_eq!(invitation.expires_at_s, 1_700_000_000);
        // §3.3: echoed byte-exact, so the string is kept rather than re-encoded.
        assert_eq!(
            invitation.linking_secret_b64,
            BASE64_STANDARD.encode([0x11u8; 32])
        );
    }

    /// §3.3. The server schema is `min(1)`, so nothing upstream catches this.
    #[test]
    fn a_secret_of_the_wrong_length_is_not_a_malformed_payload() {
        assert_eq!(
            parse_invitation(&payload(31, 1_700_000_000)),
            Err(LinkingError::InvalidLength {
                what: "linkingSecret".into(),
                expected: 32,
                actual: 31,
            })
        );
    }

    #[test]
    fn each_malformed_shape_is_its_own_refusal() {
        assert_eq!(
            parse_invitation("not json at all"),
            Err(LinkingError::InvalidQrPayload {
                what: "not JSON".into()
            })
        );
        assert_eq!(
            parse_invitation(r#"{"ephemeralPublicKey":"x","linkingSecret":"y","expiresAt":1}"#),
            Err(LinkingError::InvalidQrPayload {
                what: "sessionId is missing or not a string".into()
            })
        );
        // §3.1: the server validates a UUID while the contract says `min(1)`.
        let not_a_uuid = payload(32, 1).replace(SESSION, "session-1");
        assert_eq!(
            parse_invitation(&not_a_uuid),
            Err(LinkingError::InvalidQrPayload {
                what: "sessionId is not a UUID".into()
            })
        );
    }

    /// §3.4's boundary, in the direction that is easy to get wrong.
    #[test]
    fn a_request_at_exactly_expires_at_is_still_accepted() {
        assert_eq!(assert_not_expired(1_000, 1_000), Ok(()));
        assert_eq!(assert_not_expired(1_000, 999), Ok(()));
        assert_eq!(
            assert_not_expired(1_000, 1_001),
            Err(LinkingError::SessionExpired)
        );
    }
}

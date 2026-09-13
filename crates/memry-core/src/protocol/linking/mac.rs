//! The two MAC families of chapter 03 §3.7, and the CBOR messages they cover.
//!
//! Split out of `linking.rs` for the 600-line ceiling, along the seam §3.7
//! already draws: **anything the server verifies uses WebCrypto HMAC-SHA-256;
//! anything only devices verify uses libsodium `crypto_auth`, which is
//! HMAC-SHA-512 truncated to 32 bytes.** The two MUST NOT be unified, and
//! `LINKING_PROOF` deliberately runs through both over identical bytes.
//!
//! In every message the MAC'd value is the base64 **string** of a ciphertext,
//! never its raw bytes.

use ciborium::value::Value;

use super::{LINKING_SECRET_BYTES, LinkingError, check_length, decode_b64};
use crate::crypto::cbor::{self, CanonicalMap, field_order};
use crate::crypto::keys::SUBKEY_LEN;
use crate::crypto::sodium;

// ---------------------------------------------------------------------------
// §3.7 the two MAC families
// ---------------------------------------------------------------------------

/// The `LINKING_PROOF` CBOR message, §3.7.
///
/// Both families MAC these same bytes; only the key and the primitive differ.
pub fn linking_proof_message(
    session_id: &str,
    device_public_key_b64: &str,
) -> Result<Vec<u8>, LinkingError> {
    encode_message(
        field_order::LINKING_PROOF,
        vec![
            text("sessionId", session_id),
            text("devicePublicKey", device_public_key_b64),
        ],
    )
}

/// The `SCAN_CONFIRM` CBOR message, §3.7. The only ordering carrying
/// `initiatorPublicKey`.
pub fn scan_confirm_message(
    session_id: &str,
    initiator_public_key_b64: &str,
    device_public_key_b64: &str,
) -> Result<Vec<u8>, LinkingError> {
    encode_message(
        field_order::SCAN_CONFIRM,
        vec![
            text("sessionId", session_id),
            text("initiatorPublicKey", initiator_public_key_b64),
            text("devicePublicKey", device_public_key_b64),
        ],
    )
}

/// The `KEY_CONFIRM` CBOR message, §3.7.
///
/// `encrypted_master_key_b64` is the base64 **string**, not the ciphertext
/// bytes.
pub fn key_confirm_message(
    session_id: &str,
    encrypted_master_key_b64: &str,
) -> Result<Vec<u8>, LinkingError> {
    encode_message(
        field_order::KEY_CONFIRM,
        vec![
            text("sessionId", session_id),
            text("encryptedMasterKey", encrypted_master_key_b64),
        ],
    )
}

/// The `PROVIDER_AUTH_CONFIRM` CBOR message, §3.10.
pub fn provider_auth_confirm_message(
    session_id: &str,
    encrypted_provider_auth_b64: &str,
) -> Result<Vec<u8>, LinkingError> {
    encode_message(
        field_order::PROVIDER_AUTH_CONFIRM,
        vec![
            text("sessionId", session_id),
            text("encryptedProviderAuth", encrypted_provider_auth_b64),
        ],
    )
}

/// The `VAULT_TRANSFER_CONFIRM` CBOR message, §3.10.
pub fn vault_transfer_confirm_message(
    session_id: &str,
    encrypted_vault_transfer_b64: &str,
) -> Result<Vec<u8>, LinkingError> {
    encode_message(
        field_order::VAULT_TRANSFER_CONFIRM,
        vec![
            text("sessionId", session_id),
            text("encryptedVaultTransfer", encrypted_vault_transfer_b64),
        ],
    )
}

/// The scan-channel tag: **HMAC-SHA-256** keyed by the decoded `linkingSecret`
/// (§3.7). The sync server verifies this one, so the primitive is WebCrypto's.
pub fn scan_mac(message: &[u8], linking_secret: &[u8]) -> Result<Vec<u8>, LinkingError> {
    check_length("linkingSecret", LINKING_SECRET_BYTES, linking_secret)?;
    Ok(sodium::auth_hmacsha256(message, linking_secret)?)
}

/// Verifies a scan-channel tag in constant time.
pub fn verify_scan_mac(
    message: &[u8],
    tag_b64: &str,
    linking_secret: &[u8],
) -> Result<(), LinkingError> {
    let expected = scan_mac(message, linking_secret)?;
    let actual = decode_b64("scan-channel MAC", tag_b64)?;
    if sodium::memcmp(&expected, &actual) {
        Ok(())
    } else {
        Err(LinkingError::ScanMacInvalid)
    }
}

/// The confirm-channel tag: libsodium `crypto_auth`, **HMAC-SHA-512 truncated
/// to 32 bytes** (§3.7). Only the peer device verifies it.
pub fn confirm_mac(message: &[u8], mac_key: &[u8]) -> Result<Vec<u8>, LinkingError> {
    check_length("memrymac subkey", SUBKEY_LEN, mac_key)?;
    Ok(sodium::auth(message, mac_key)?)
}

/// Verifies a confirm-channel tag in constant time.
///
/// §3.9: a caller MUST run this before it touches the material the tag covers,
/// and MUST wipe the shared secret and both subkeys on failure.
pub fn verify_confirm_mac(
    message: &[u8],
    tag_b64: &str,
    mac_key: &[u8],
) -> Result<(), LinkingError> {
    let expected = confirm_mac(message, mac_key)?;
    let actual = decode_b64("confirm-channel MAC", tag_b64)?;
    if sodium::memcmp(&expected, &actual) {
        Ok(())
    } else {
        Err(LinkingError::ConfirmMacInvalid)
    }
}

fn encode_message(
    field_order: &[&str],
    entries: Vec<(String, Value)>,
) -> Result<Vec<u8>, LinkingError> {
    let map: CanonicalMap = entries;
    Ok(cbor::encode(field_order, &map)?)
}

fn text(key: &str, value: &str) -> (String, Value) {
    (key.to_string(), Value::Text(value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231 test case 2: key `Jefe`, message `what do ya want for nothing?`.
    /// Kept after the construction moved into `crypto::sodium`, because it now
    /// pins the seam rather than a local helper — and the key here is 4 bytes,
    /// which `crypto_auth`'s fixed-length door would have rejected outright.
    #[test]
    fn hmac_sha256_matches_rfc_4231_case_2() {
        assert_eq!(
            hex::encode(
                sodium::auth_hmacsha256(b"what do ya want for nothing?", b"Jefe").expect("hmac")
            ),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// RFC 4231 case 6 uses a 131-byte key, the branch that folds the key by
    /// hashing it first. libsodium does this internally; the test is what
    /// proves it, rather than the assumption that it does.
    #[test]
    fn hmac_sha256_hashes_an_over_long_key() {
        assert_eq!(
            hex::encode(
                sodium::auth_hmacsha256(
                    b"Test Using Larger Than Block-Size Key - Hash Key First",
                    &[0xaa; 131]
                )
                .expect("hmac")
            ),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    /// §3.7's most missable fact, as a negative control: the two families over
    /// identical bytes must not reproduce each other.
    #[test]
    fn the_two_mac_families_do_not_reproduce_each_other() {
        let key = [0x11u8; 32];
        let message = b"the same bytes on both channels";
        assert_ne!(
            scan_mac(message, &key).expect("scan"),
            confirm_mac(message, &key).expect("confirm")
        );
    }
}

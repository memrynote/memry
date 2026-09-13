//! Device linking, chapter 03.
//!
//! The cryptographic half of the five-route flow: the X25519 agreement of
//! §3.5, the three subkeys of chapter 01 §1.2, the two MAC families of §3.7,
//! the master key block of §3.10 and the short verification code of §3.6.
//! Routing, polling and session state belong to the transport layers above;
//! nothing in this file talks to a server.
//!
//! Four facts shape the module, and each is the opposite of the reasonable
//! guess:
//!
//! 1. **The raw `crypto_scalarmult` output is the KDF key** (§3.5). No
//!    `crypto_kx`, no hash of the shared secret first.
//! 2. **There are two MAC families and they MUST NOT be unified** (§3.7). The
//!    scan channel is HMAC-SHA-256 keyed by the decoded `linkingSecret`,
//!    because a Cloudflare Worker verifies it; the confirm channel is
//!    libsodium `crypto_auth`, HMAC-SHA-512 truncated to 32 bytes — which is
//!    **not** SHA-512/256, a different IV. `LINKING_PROOF` runs through both
//!    over identical bytes, and both tags ride in the same `/scan` body.
//! 3. **The MAC'd value is always the base64 _string_ of a ciphertext**, never
//!    its raw bytes (§3.7).
//! 4. **The SAS reproduces its modular bias** (§3.6). See
//!    [`short_verification_code`].
//!
//! §3.11.2 is the normative rule for `LINKING_IP_MISMATCH`: the binding is
//! relaxed and a conforming server MUST NOT reject `complete` on an IP change,
//! so this module has no IP-derived state and a client built on it must not
//! invent one. §3.11.3's obligation on a legacy server — zero the subkeys and
//! do not retry — is satisfied by dropping [`LinkingSubkeys`], whose every
//! field zeroes on drop.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use thiserror::Error;
use zeroize::Zeroizing;

use crate::api::errors::{CborError, CryptoError};
use crate::crypto::keys::SUBKEY_LEN;
use crate::crypto::sodium;

/// The decoded `linkingSecret`, §3.3. The wire form is a 44-character standard
/// base64 string; **the HMAC key is these 32 raw bytes, not the string**.
pub const LINKING_SECRET_BYTES: usize = 32;

/// X25519 public keys and scalars are 32 bytes, §3.5.
pub const X25519_KEY_BYTES: usize = 32;

/// The server-chosen session TTL, §3.4. Recorded here so a chapter edit is a
/// red build; a client MUST use the server's `expiresAt` rather than this.
pub const LINKING_SESSION_TTL_SECONDS: u64 = 300;

/// Subkey 5, `memrylnk`: the linking transport key (chapter 01 §1.2).
pub const LINKING_ENC_CONTEXT: &[u8; 8] = b"memrylnk";
/// Subkey id of [`LINKING_ENC_CONTEXT`].
pub const LINKING_ENC_SUBKEY_ID: u64 = 5;
/// Subkey 6, `memrymac`: the confirm-channel MAC key (chapter 01 §1.2).
pub const LINKING_MAC_CONTEXT: &[u8; 8] = b"memrymac";
/// Subkey id of [`LINKING_MAC_CONTEXT`].
pub const LINKING_MAC_SUBKEY_ID: u64 = 6;
/// Subkey 7, `memrysas`: the short verification code key (chapter 01 §1.2).
pub const LINKING_SAS_CONTEXT: &[u8; 8] = b"memrysas";
/// Subkey id of [`LINKING_SAS_CONTEXT`].
pub const LINKING_SAS_SUBKEY_ID: u64 = 7;

/// The BLAKE2b output the SAS is read from, §3.6.
pub const SAS_HASH_BYTES: usize = 4;
/// Decimal digits in the SAS, §3.6. Six, not words.
pub const SAS_DIGITS: usize = 6;
/// The SAS modulus, §3.6. `10^6`, and the source of the deliberate bias.
pub const SAS_MODULUS: u32 = 1_000_000;

/// §3.7's two MAC families and the five CBOR messages they cover. Split out
/// for the 600-line ceiling; re-exported so the module path a caller uses is
/// `protocol::linking::scan_mac`, not `protocol::linking::mac::scan_mac`.
pub mod mac;

pub use mac::{
    confirm_mac, key_confirm_message, linking_proof_message, provider_auth_confirm_message,
    scan_confirm_message, scan_mac, vault_transfer_confirm_message, verify_confirm_mac,
    verify_scan_mac,
};

/// Failures of the device-linking crypto, chapter 03.
///
/// The scan and confirm channels get their own rejection variants because a
/// caller does different things with them: a scan-channel failure is the
/// server's `LINKING_SECRET_INVALID` (§3.12) and means the QR was wrong, while
/// a confirm-channel failure means the peer does not hold the shared secret and
/// MUST wipe the session (§3.9). Distinguishing them by variant rather than by
/// an English message is what makes that portable.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LinkingError {
    /// A key, nonce or public point arrived at the wrong size.
    #[error("{what} is {actual} bytes, expected {expected}")]
    InvalidLength {
        what: String,
        expected: u64,
        actual: u64,
    },

    /// A field the protocol spells as standard-alphabet base64 did not decode.
    #[error("{what} is not standard-alphabet base64")]
    InvalidBase64 { what: String },

    /// A scan-channel tag did not verify under the decoded `linkingSecret`.
    #[error("scan-channel MAC did not verify")]
    ScanMacInvalid,

    /// A confirm-channel tag did not verify under the `memrymac` subkey.
    ///
    /// §3.9: raised **before** the master key is touched, so an item that fails
    /// here is never decrypted.
    #[error("confirm-channel MAC did not verify")]
    ConfirmMacInvalid,

    #[error("{source}")]
    Crypto {
        #[from]
        source: CryptoError,
    },

    #[error("{source}")]
    Cbor {
        #[from]
        source: CborError,
    },
}

/// The three linking subkeys of §3.5, all 32 bytes, all zeroed on drop.
pub struct LinkingSubkeys {
    /// `memrylnk` id 5: XChaCha20-Poly1305 key for the transported blocks.
    pub encryption: Zeroizing<Vec<u8>>,
    /// `memrymac` id 6: `crypto_auth` key for the confirm channel.
    pub mac: Zeroizing<Vec<u8>>,
    /// `memrysas` id 7: the short verification code key.
    pub sas: Zeroizing<Vec<u8>>,
}

/// The transported master key, §3.10. Both fields are standard base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterKeyBlock {
    /// `encryptedMasterKey`: XChaCha20-Poly1305 ciphertext plus tag.
    pub encrypted_master_key_b64: String,
    /// `encryptedKeyNonce`: the 24-byte nonce the block was sealed under.
    pub encrypted_key_nonce_b64: String,
}

// ---------------------------------------------------------------------------
// §3.5 key agreement
// ---------------------------------------------------------------------------

/// A fresh ephemeral X25519 pair, §3.5.
///
/// The chapter cites `crypto_box_keypair`, which is 32 random bytes followed by
/// `crypto_scalarmult_base`; spelling it that way keeps every libsodium call in
/// this crate inside `crypto::sodium` and produces an identical pair.
///
/// Returns `(public_key, secret_key)`.
pub fn ephemeral_keypair() -> Result<(Vec<u8>, Zeroizing<Vec<u8>>), LinkingError> {
    let secret = Zeroizing::new(sodium::random_bytes(X25519_KEY_BYTES));
    let public = sodium::scalarmult_base(&secret)?;
    Ok((public, secret))
}

/// The raw X25519 shared secret, §3.5.
///
/// **The output is fed straight to the KDF**: it is not hashed, and there is no
/// `crypto_kx`. Both inputs carry explicit 32-byte checks because the chapter
/// cites them on the reference implementation, and because a short scalar is a
/// caller bug worth naming rather than a low-order-point rejection.
pub fn shared_secret(
    my_secret_key: &[u8],
    their_public_key: &[u8],
) -> Result<Zeroizing<Vec<u8>>, LinkingError> {
    check_length("x25519 secret key", X25519_KEY_BYTES, my_secret_key)?;
    check_length("x25519 public key", X25519_KEY_BYTES, their_public_key)?;
    Ok(sodium::scalarmult(my_secret_key, their_public_key)?)
}

/// Derives all three subkeys of §3.5 from the raw shared secret.
pub fn derive_subkeys(shared_secret: &[u8]) -> Result<LinkingSubkeys, LinkingError> {
    Ok(LinkingSubkeys {
        encryption: derive_linking_subkey(
            shared_secret,
            LINKING_ENC_SUBKEY_ID,
            LINKING_ENC_CONTEXT,
        )?,
        mac: derive_linking_subkey(shared_secret, LINKING_MAC_SUBKEY_ID, LINKING_MAC_CONTEXT)?,
        sas: derive_linking_subkey(shared_secret, LINKING_SAS_SUBKEY_ID, LINKING_SAS_CONTEXT)?,
    })
}

fn derive_linking_subkey(
    shared_secret: &[u8],
    subkey_id: u64,
    context: &[u8; 8],
) -> Result<Zeroizing<Vec<u8>>, LinkingError> {
    Ok(sodium::kdf_derive_from_key(
        SUBKEY_LEN,
        subkey_id,
        context,
        shared_secret,
    )?)
}

/// Decodes the QR's `linkingSecret` into the 32-byte scan-channel HMAC key,
/// §3.3.
///
/// The server schema is only `z.string().min(1)`, so **the length check is the
/// client's**; a decoded length other than 32 is rejected here.
pub fn decode_linking_secret(linking_secret_b64: &str) -> Result<Zeroizing<Vec<u8>>, LinkingError> {
    let bytes = Zeroizing::new(decode_b64("linkingSecret", linking_secret_b64)?);
    check_length("linkingSecret", LINKING_SECRET_BYTES, &bytes)?;
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// §3.10 the master key block
// ---------------------------------------------------------------------------

/// Seals the master key under the linking encryption key, §3.10.
///
/// **No associated data**, unlike the two optional blocks. Getting that wrong
/// produces a block the peer cannot open, with no other symptom.
pub fn seal_master_key(
    master_key: &[u8],
    encryption_key: &[u8],
    nonce: &[u8],
) -> Result<MasterKeyBlock, LinkingError> {
    check_length("master key", SUBKEY_LEN, master_key)?;
    let ciphertext = sodium::aead_encrypt(master_key, None, nonce, encryption_key)?;
    Ok(MasterKeyBlock {
        encrypted_master_key_b64: BASE64_STANDARD.encode(&ciphertext),
        encrypted_key_nonce_b64: BASE64_STANDARD.encode(nonce),
    })
}

/// Opens a master key block, §3.10. Callers on the linking path should prefer
/// [`receive_master_key`], which enforces §3.9's ordering.
pub fn open_master_key(
    block: &MasterKeyBlock,
    encryption_key: &[u8],
) -> Result<Zeroizing<Vec<u8>>, LinkingError> {
    let ciphertext = decode_b64("encryptedMasterKey", &block.encrypted_master_key_b64)?;
    let nonce = decode_b64("encryptedKeyNonce", &block.encrypted_key_nonce_b64)?;
    let plaintext = sodium::aead_decrypt(&ciphertext, None, &nonce, encryption_key)?;
    check_length("master key", SUBKEY_LEN, &plaintext)?;
    Ok(plaintext)
}

/// The approving device's half of §3.9: seal the master key, then MAC the
/// base64 of the ciphertext under `KEY_CONFIRM`.
///
/// Returns the block and the raw `keyConfirm` tag.
pub fn send_master_key(
    session_id: &str,
    master_key: &[u8],
    subkeys: &LinkingSubkeys,
    nonce: &[u8],
) -> Result<(MasterKeyBlock, Vec<u8>), LinkingError> {
    let block = seal_master_key(master_key, &subkeys.encryption, nonce)?;
    let message = key_confirm_message(session_id, &block.encrypted_master_key_b64)?;
    let tag = confirm_mac(&message, &subkeys.mac)?;
    Ok((block, tag))
}

/// The new device's half of §3.9: **verify `keyConfirm` before decrypting**.
///
/// The ordering is structural rather than a rule to remember — there is no
/// path through this function that decrypts an unverified block.
pub fn receive_master_key(
    session_id: &str,
    block: &MasterKeyBlock,
    key_confirm_b64: &str,
    subkeys: &LinkingSubkeys,
) -> Result<Zeroizing<Vec<u8>>, LinkingError> {
    let message = key_confirm_message(session_id, &block.encrypted_master_key_b64)?;
    verify_confirm_mac(&message, key_confirm_b64, &subkeys.mac)?;
    open_master_key(block, &subkeys.encryption)
}

// ---------------------------------------------------------------------------
// §3.6 the short verification code
// ---------------------------------------------------------------------------

/// The six-digit SAS, §3.6, from the raw shared secret.
///
/// ```text
/// sasKey = crypto_kdf_derive_from_key(32, 7, "memrysas", sharedSecret)
/// h      = crypto_generichash(4, sasKey, key = null)
/// u32    = big-endian unsigned read of h
/// code   = u32 % 1_000_000, zero padded to six digits
/// ```
///
/// **The modular bias is reproduced, not corrected.** `2^32 mod 10^6 = 967_296`,
/// so each code below `967296` is reachable from 4295 `u32` values and each code
/// at or above it from 4294 — about one part in 4295, and about 19.93 bits of
/// entropy rather than a clean 20. Substituting rejection sampling yields a
/// **different** code, so the two devices being linked would display different
/// numbers to the user and linking would fail with nothing logged anywhere. The
/// bias is the specification.
pub fn short_verification_code(shared_secret: &[u8]) -> Result<String, LinkingError> {
    let sas_key = derive_linking_subkey(shared_secret, LINKING_SAS_SUBKEY_ID, LINKING_SAS_CONTEXT)?;
    sas_code_from_key(&sas_key)
}

/// [`short_verification_code`] from an already-derived `memrysas` subkey.
pub fn sas_code_from_key(sas_key: &[u8]) -> Result<String, LinkingError> {
    check_length("memrysas subkey", SUBKEY_LEN, sas_key)?;
    let digest = sodium::generichash(SAS_HASH_BYTES, sas_key, None)?;
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    Ok(format!(
        "{:0width$}",
        value % SAS_MODULUS,
        width = SAS_DIGITS
    ))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

pub(crate) fn decode_b64(what: &str, value: &str) -> Result<Vec<u8>, LinkingError> {
    BASE64_STANDARD
        .decode(value)
        .map_err(|_| LinkingError::InvalidBase64 { what: what.into() })
}

pub(crate) fn check_length(what: &str, expected: usize, actual: &[u8]) -> Result<(), LinkingError> {
    if actual.len() == expected {
        return Ok(());
    }
    Err(LinkingError::InvalidLength {
        what: what.into(),
        expected: expected as u64,
        actual: actual.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::keys::kdf_context;

    /// The three linking rows here and the seven-row table in `crypto::keys`
    /// must be one fact, not two. Chapter 01 §1.2 owns the table; this asserts
    /// the chapter-03 constants against it.
    #[test]
    fn the_three_subkey_rows_match_the_chapter_01_table() {
        for (logical, ctx, id) in [
            (
                "memry-linking-enc-v1",
                LINKING_ENC_CONTEXT,
                LINKING_ENC_SUBKEY_ID,
            ),
            (
                "memry-linking-mac-v1",
                LINKING_MAC_CONTEXT,
                LINKING_MAC_SUBKEY_ID,
            ),
            (
                "memry-linking-sas-v1",
                LINKING_SAS_CONTEXT,
                LINKING_SAS_SUBKEY_ID,
            ),
        ] {
            let row = kdf_context(logical).unwrap_or_else(|| panic!("no row for {logical}"));
            assert_eq!(row.ctx, ctx, "{logical}: ctx");
            assert_eq!(row.subkey_id, id, "{logical}: subkey id");
        }
    }

    /// §3.5's agreement is symmetric; the vectors assert `sharedSecretsAgree`
    /// without publishing either scalar, so this is where that claim is checked.
    #[test]
    fn both_sides_reach_the_same_shared_secret() {
        let (initiator_public, initiator_secret) = ephemeral_keypair().expect("initiator");
        let (device_public, device_secret) = ephemeral_keypair().expect("device");

        let from_initiator = shared_secret(&initiator_secret, &device_public).expect("initiator");
        let from_device = shared_secret(&device_secret, &initiator_public).expect("device");

        assert_eq!(from_initiator.as_slice(), from_device.as_slice());
        assert_eq!(
            short_verification_code(&from_initiator).expect("sas"),
            short_verification_code(&from_device).expect("sas")
        );
    }

    /// §3.3: the length check is the client's, because the server schema is
    /// only `min(1)`.
    #[test]
    fn a_linking_secret_of_the_wrong_length_is_rejected() {
        let short = BASE64_STANDARD.encode([0x11u8; 31]);
        assert_eq!(
            decode_linking_secret(&short),
            Err(LinkingError::InvalidLength {
                what: "linkingSecret".into(),
                expected: 32,
                actual: 31,
            })
        );
    }
}

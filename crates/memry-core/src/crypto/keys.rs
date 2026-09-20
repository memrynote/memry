//! The key chain of chapter 01.
//!
//! Three steps and nothing else derives a master key (§1.1): phrase to seed,
//! seed to master key through Argon2id, master key to subkey through
//! `crypto_kdf_derive_from_key`. Everything in this file is one of those steps
//! or one of the two verifiers built on top of them.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use zeroize::Zeroizing;

use crate::api::errors::CryptoError;
use crate::crypto::sodium;

/// Argon2id parameters, chapter 01 §1.1. Parallelism is never passed:
/// libsodium's `crypto_pwhash` uses 1 internally and that is the canonical
/// value for this protocol, not the 4 some prose elsewhere mentions.
pub const ARGON2_OPS_LIMIT: u64 = 3;
pub const ARGON2_MEMORY_LIMIT: usize = 67_108_864;
pub const ARGON2_SALT_LENGTH: usize = 16;

/// A fresh account salt, chapter 01 §1.1: [`ARGON2_SALT_LENGTH`] bytes of
/// libsodium randomness.
///
/// Here rather than in the shell so that the length and the generator are the
/// same two facts [`derive_master_key`] checks against. A salt is not a secret
/// — it is published with the account — but a salt of the wrong length is a
/// key nothing can re-derive.
pub fn generate_kdf_salt() -> Vec<u8> {
    sodium::random_bytes(ARGON2_SALT_LENGTH)
}

/// Every derived key in this protocol is 32 bytes (chapter 01 §1.2).
pub const SUBKEY_LEN: usize = 32;
/// The locally derived device id is a 16-byte BLAKE2b (chapter 01 §1.5).
pub const DEVICE_ID_LEN: usize = 16;

/// One row of the KDF context table, chapter 01 §1.2.
///
/// `logical` is a lookup key that appears in contracts; `ctx` is the eight-byte
/// value actually handed to libsodium. Confusing the two derives a different key
/// and unlocks nothing.
pub struct KdfContext {
    pub logical: &'static str,
    pub ctx: &'static [u8; 8],
    pub subkey_id: u64,
}

/// The seven rows of chapter 01 §1.2, in subkey-id order.
///
/// Ids 2 and 3 are **reserved, not dead** (§1.2.1): no production caller exists,
/// a conforming client MAY omit the derivation, and no client may ever reuse the
/// id or the context string for anything else. They stay in the table so that a
/// future user of either is forced to change a committed vector.
pub const KDF_CONTEXTS: [KdfContext; 7] = [
    KdfContext {
        logical: "memry-vault-key-v1",
        ctx: b"memryvlt",
        subkey_id: 1,
    },
    KdfContext {
        logical: "memry-signing-key-v1",
        ctx: b"memrysgn",
        subkey_id: 2,
    },
    KdfContext {
        logical: "memry-verify-key-v1",
        ctx: b"memryvrf",
        subkey_id: 3,
    },
    KdfContext {
        logical: "memry-key-verifier-v1",
        ctx: b"memrykve",
        subkey_id: 4,
    },
    KdfContext {
        logical: "memry-linking-enc-v1",
        ctx: b"memrylnk",
        subkey_id: 5,
    },
    KdfContext {
        logical: "memry-linking-mac-v1",
        ctx: b"memrymac",
        subkey_id: 6,
    },
    KdfContext {
        logical: "memry-linking-sas-v1",
        ctx: b"memrysas",
        subkey_id: 7,
    },
];

/// Looks a row up by its logical context name.
pub fn kdf_context(logical: &str) -> Option<&'static KdfContext> {
    KDF_CONTEXTS.iter().find(|row| row.logical == logical)
}

/// The message prefix of the local vault key verifier, chapter 01 §1.4.2.
pub const VAULT_KEY_VERIFIER_PREFIX: &str = "memry/vault-key-verifier/v1/";

/// Seed to master key, chapter 01 §1.1 step two.
///
/// The 64-byte BIP-39 seed is the Argon2id *password*, not a key, and the salt
/// is the account's 16 random `kdfSalt` bytes.
pub fn derive_master_key(seed: &[u8], kdf_salt: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if kdf_salt.len() != ARGON2_SALT_LENGTH {
        return Err(CryptoError::InvalidLength {
            what: "kdfSalt".into(),
            expected: ARGON2_SALT_LENGTH as u64,
            actual: kdf_salt.len() as u64,
        });
    }
    sodium::pwhash_argon2id(
        SUBKEY_LEN,
        seed,
        kdf_salt,
        ARGON2_OPS_LIMIT,
        ARGON2_MEMORY_LIMIT,
    )
}

/// Master key to subkey, chapter 01 §1.1 step three.
pub fn derive_subkey(
    master_key: &[u8],
    subkey_id: u64,
    context: &[u8; 8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    sodium::kdf_derive_from_key(SUBKEY_LEN, subkey_id, context, master_key)
}

/// The vault key, chapter 01 §1.7.
///
/// **No vault id enters this derivation.** One account has one vault key, so a
/// ciphertext from vault A decrypts cleanly under vault B and decryption failure
/// is never a mis-routing signal — vault association is checked explicitly from
/// the route, never inferred from the crypto.
pub fn derive_vault_key(master_key: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    derive_subkey(master_key, 1, b"memryvlt")
}

/// The account key verifier, chapter 01 §1.4.1.
///
/// Literally base64 of subkey 4 with **no hash wrapper**. Server-visible.
pub fn account_key_verifier(master_key: &[u8]) -> Result<String, CryptoError> {
    let subkey = derive_subkey(master_key, 4, b"memrykve")?;
    Ok(BASE64_STANDARD.encode(subkey.as_slice()))
}

/// Compares two account key verifiers, chapter 01 §1.4.1.
///
/// **Over the base64 strings re-encoded as UTF-8, not over the decoded bytes.**
/// Comparing decoded bytes accepts every correct input and fails to reject some
/// incorrect ones, because two distinct base64 spellings can decode to the same
/// bytes. Lengths are compared first, then `sodium_memcmp`, exactly as the
/// reference does.
pub fn account_key_verifier_matches(local: &str, server: &str) -> bool {
    sodium::memcmp(local.as_bytes(), server.as_bytes())
}

/// The local vault key verifier, chapter 01 §1.4.2.
///
/// A keyed BLAKE2b-256 whose **key** is the vault key and whose **message** is
/// the context string with the vault id appended — the one place a vault id
/// touches key material. It MUST NOT be sent to the server.
pub fn local_vault_key_verifier(vault_key: &[u8], vault_id: &str) -> Result<String, CryptoError> {
    let message = format!("{VAULT_KEY_VERIFIER_PREFIX}{vault_id}");
    let hash = sodium::generichash(SUBKEY_LEN, message.as_bytes(), Some(vault_key))?;
    Ok(BASE64_STANDARD.encode(hash))
}

/// The locally derived device id, chapter 01 §1.5: 32 lowercase hex characters.
///
/// This is **not** the wire identity. A conforming client stores and sends the
/// server-assigned `deviceId` from `POST /auth/devices`; this value is computed
/// at registration time and then stops mattering.
pub fn local_device_id_hex(ed25519_public_key: &[u8]) -> Result<String, CryptoError> {
    let hash = sodium::generichash(DEVICE_ID_LEN, ed25519_public_key, None)?;
    Ok(hex::encode(hash))
}

/// Standard-alphabet base64 **with** padding, chapter 04 §4.5. Not URL-safe.
pub fn base64_encode(bytes: &[u8]) -> String {
    BASE64_STANDARD.encode(bytes)
}

/// Decodes standard-alphabet base64, chapter 04 §4.5.
pub fn base64_decode(text: &str) -> Result<Vec<u8>, CryptoError> {
    BASE64_STANDARD
        .decode(text)
        .map_err(|_| CryptoError::InvalidBase64)
}

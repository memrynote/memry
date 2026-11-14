//! The crypto surface the shells call, exported through UniFFI.
//!
//! **Keys cross as bytes, never as `String`.** A 32-byte key rendered as hex or
//! base64 for the FFI hop is a secret that Swift's immutable `String` storage
//! will keep alive somewhere the core cannot zero, and it invites a caller to
//! log it. `Data` in, `Data` out.
//!
//! The two **verifiers** are the deliberate exception and are `String` on
//! purpose: chapter 01 §1.4.1 defines the account key verifier as a base64
//! string and requires the comparison to happen over those strings rather than
//! over the decoded bytes. Handing Swift the decoded bytes would make the wrong
//! comparison the easy one to write.

use crate::api::errors::{CompressError, CryptoError, RecoveryError};
use crate::crypto::vault_name::{self, SealedText, VaultText};
use crate::crypto::{keys, recovery};
use crate::protocol::compress;

/// A new 24-word recovery phrase, for an account that has none yet.
///
/// Chapter 01 §1.3, and the call that makes first-device setup possible on a
/// phone at all. The entropy is libsodium's; the words are English BIP-39; the
/// form is the canonical one [`validate_recovery_phrase`] produces, so the
/// phrase this returns and the phrase a user types back reach the same key.
///
/// **The caller owns what happens next.** Nothing is stored, nothing is sent,
/// and the account is not set up by this call: it is a string, and it is the
/// account until the user has written it down.
#[uniffi::export]
pub fn generate_recovery_phrase() -> String {
    recovery::generate_phrase().to_string()
}

/// A new account KDF salt, chapter 01 §1.1: 16 bytes of libsodium randomness.
///
/// Its own call rather than a constant the shell fills, because the **length**
/// is the chapter's and [`derive_master_key`] refuses any other. A salt minted
/// in the shell is a second place that rule lives.
#[uniffi::export]
pub fn generate_kdf_salt() -> Vec<u8> {
    keys::generate_kdf_salt()
}

/// Normalises and validates a recovery phrase, returning the canonical form.
///
/// Chapter 01 §1.3. Distinguishes an unknown word from a bad checksum, because
/// the first names a word to fix and the second says every word is real but the
/// phrase is not one Memry issued.
#[uniffi::export]
pub fn validate_recovery_phrase(phrase: String) -> Result<String, RecoveryError> {
    recovery::validate_phrase(&phrase)
}

/// Phrase and account salt to the 32-byte master key, chapter 01 §1.1.
///
/// This is the Argon2id pass: 64 MiB and three iterations, and the one call in
/// the product that can fail for lack of memory rather than for a wrong input.
/// The `RecoveryError::Crypto` variant carries that distinction outward so a
/// shell never tells the user to re-type a phrase that was correct.
#[uniffi::export]
pub fn derive_master_key(phrase: String, kdf_salt: Vec<u8>) -> Result<Vec<u8>, RecoveryError> {
    let seed = recovery::phrase_to_seed(&phrase)?;
    Ok(keys::derive_master_key(seed.as_slice(), &kdf_salt)?.to_vec())
}

/// The vault key for an account, chapter 01 §1.7.
///
/// One account, one vault key: no vault id enters the derivation. A caller
/// **MUST NOT** treat a successful decrypt as proof that a record belongs to the
/// vault it was routed to, because a ciphertext from any vault on the account
/// decrypts cleanly under this key.
#[uniffi::export]
pub fn derive_vault_key(master_key: Vec<u8>) -> Result<Vec<u8>, CryptoError> {
    Ok(keys::derive_vault_key(&master_key)?.to_vec())
}

/// The server-visible account key verifier, chapter 01 §1.4.1.
#[uniffi::export]
pub fn account_key_verifier(master_key: Vec<u8>) -> Result<String, CryptoError> {
    keys::account_key_verifier(&master_key)
}

/// Constant-time verifier comparison, chapter 01 §1.4.1.
///
/// Over the base64 strings, not the decoded bytes. Exported so that no shell has
/// to write the comparison, and so no shell writes the decoded-bytes version
/// that accepts every correct input and fails to reject some incorrect ones.
#[uniffi::export]
pub fn account_key_verifier_matches(local: String, server: String) -> bool {
    keys::account_key_verifier_matches(&local, &server)
}

/// The local vault key verifier, chapter 01 §1.4.2.
///
/// Never sent to the server. A change in this value means the vault key changed,
/// and key-scoped sync state must be purged so a stale cursor cannot skip items.
#[uniffi::export]
pub fn local_vault_key_verifier(
    vault_key: Vec<u8>,
    vault_id: String,
) -> Result<String, CryptoError> {
    keys::local_vault_key_verifier(&vault_key, &vault_id)
}

/// The locally derived device id, chapter 01 §1.5: 32 lowercase hex characters.
///
/// Computed at registration time. The **wire** identity is the server-assigned
/// `deviceId` from `POST /auth/devices`, not this value.
#[uniffi::export]
pub fn local_device_id_hex(ed25519_public_key: Vec<u8>) -> Result<String, CryptoError> {
    keys::local_device_id_hex(&ed25519_public_key)
}

/// Frames a payload with the chapter 04 §4.1 compression flag.
#[uniffi::export]
pub fn compress_payload(payload: Vec<u8>) -> Vec<u8> {
    compress::compress(&payload)
}

/// Unframes a payload, chapter 04 §4.1.
///
/// A truncated `0x01` stream is an error, never an empty result: an empty result
/// reaches the applier as a content wipe.
#[uniffi::export]
pub fn decompress_payload(frame: Vec<u8>) -> Result<Vec<u8>, CompressError> {
    compress::decompress(&frame)
}

/// The core's own version, for the `x-memry-client` header and for a shell that
/// wants to show what it is running.
#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// A vault's name, opened from the sealed form the registry carries.
///
/// The server never sees a vault name: desktop seals it under the vault key
/// with `vault-name-v1:<vaultUuid>` as associated data (chapter 04 §4.15,
/// `apps/desktop/src/main/sync/vault-name-crypto.ts`), so the registry row
/// holds only `encryptedName` and `nameNonce`. The associated data binds the
/// name to its vault, which is what stops a server swapping two rows' names.
///
/// `None` for anything that does not open — a malformed field, a wrong key, a
/// name sealed for another vault. Desktop answers the same way, and a shell
/// then says the vault has no readable name rather than drawing ciphertext.
#[uniffi::export]
pub fn decrypt_vault_name(
    master_key: Vec<u8>,
    vault_id: String,
    encrypted_name: String,
    name_nonce: String,
) -> Option<String> {
    let vault_key = keys::derive_vault_key(&master_key).ok()?;
    vault_name::open(
        VaultText::Name,
        &vault_key,
        &vault_id,
        &encrypted_name,
        &name_nonce,
    )
}

/// A vault's name sealed for `POST /sync/vaults` (chapter 04 §4.15): the
/// `encryptedName` and `nameNonce` Electron's `encryptVaultName` writes.
pub fn encrypt_vault_name(
    master_key: &[u8],
    vault_id: &str,
    name: &str,
) -> Result<SealedText, CryptoError> {
    let vault_key = keys::derive_vault_key(master_key)?;
    vault_name::seal(VaultText::Name, &vault_key, vault_id, name)
}

/// A vault's icon sealed for `PUT /sync/vaults/:vaultId/icon` (chapter 04
/// §4.16): the `encryptedIcon` and `iconNonce` Electron's `encryptVaultIcon`
/// writes. The caller validates the value first (`VaultIconSchema`).
pub fn encrypt_vault_icon(
    master_key: &[u8],
    vault_id: &str,
    icon: &str,
) -> Result<SealedText, CryptoError> {
    let vault_key = keys::derive_vault_key(master_key)?;
    vault_name::seal(VaultText::Icon, &vault_key, vault_id, icon)
}

/// A vault's icon opened from `encryptedIcon` and `iconNonce`, `None` when it
/// does not open (chapter 04 §4.16). An opened value is untrusted text: the
/// caller validates it and keeps its local icon when it does not pass.
pub fn decrypt_vault_icon(
    master_key: &[u8],
    vault_id: &str,
    encrypted_icon: &str,
    icon_nonce: &str,
) -> Option<String> {
    let vault_key = keys::derive_vault_key(master_key).ok()?;
    vault_name::open(
        VaultText::Icon,
        &vault_key,
        vault_id,
        encrypted_icon,
        icon_nonce,
    )
}

#[cfg(test)]
mod vault_name_crypto {
    use super::*;

    const MASTER: [u8; 32] = [3u8; 32];

    #[test]
    fn a_sealed_name_opens_to_its_plaintext() {
        let sealed = encrypt_vault_name(&MASTER, "v1", "MemryNote").expect("seal");
        assert_eq!(
            decrypt_vault_name(
                MASTER.to_vec(),
                "v1".into(),
                sealed.ciphertext,
                sealed.nonce
            )
            .as_deref(),
            Some("MemryNote")
        );
    }

    #[test]
    fn a_sealed_icon_opens_to_its_plaintext() {
        let sealed = encrypt_vault_icon(&MASTER, "v1", "icon:Book01Icon").expect("seal");
        assert_eq!(
            decrypt_vault_icon(&MASTER, "v1", &sealed.ciphertext, &sealed.nonce).as_deref(),
            Some("icon:Book01Icon")
        );
    }

    /// The two prefixes keep the envelopes apart: a server cannot hand a name
    /// back as an icon, or an icon as a name.
    #[test]
    fn a_name_never_opens_as_an_icon_nor_an_icon_as_a_name() {
        let name = encrypt_vault_name(&MASTER, "v1", "MemryNote").expect("seal");
        let icon = encrypt_vault_icon(&MASTER, "v1", "🌿").expect("seal");
        assert_eq!(
            decrypt_vault_icon(&MASTER, "v1", &name.ciphertext, &name.nonce),
            None
        );
        assert_eq!(
            decrypt_vault_name(MASTER.to_vec(), "v1".into(), icon.ciphertext, icon.nonce),
            None
        );
    }

    /// The associated data is the vault id, so a name moved onto another
    /// vault's row does not open — which is the point of binding it.
    #[test]
    fn a_name_sealed_for_another_vault_does_not_open() {
        let sealed = encrypt_vault_name(&MASTER, "v1", "MemryNote").expect("seal");
        assert_eq!(
            decrypt_vault_name(
                MASTER.to_vec(),
                "v2".into(),
                sealed.ciphertext,
                sealed.nonce
            ),
            None
        );
    }

    #[test]
    fn a_wrong_key_does_not_open() {
        let sealed = encrypt_vault_icon(&MASTER, "v1", "🌿").expect("seal");
        assert_eq!(
            decrypt_vault_icon(&[4u8; 32], "v1", &sealed.ciphertext, &sealed.nonce),
            None
        );
    }
}

//! The vault-name and vault-icon envelopes, chapter 04 §4.15 and §4.16: how a
//! vault's name and icon reach the account registry without the server
//! reading them (`apps/desktop/src/main/sync/vault-name-crypto.ts`).
//!
//! XChaCha20-Poly1305 under the vault key, with `vault-name-v1:<vaultUuid>` or
//! `vault-icon-v1:<vaultUuid>` as associated data, ciphertext and nonce in
//! standard base64. The vault id binds a name to its row, and the two prefixes
//! keep a name from opening as an icon. Every device on the account reads the
//! same registry, so a seal here is Electron's bytes under the same nonce
//! (`packages/contracts/test-vectors/vault-name.json`).

use crate::api::errors::CryptoError;
use crate::crypto::keys::{base64_decode, base64_encode};
use crate::crypto::sodium;

const NONCE_LEN: usize = 24;

/// Which field of a registry row an envelope seals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultText {
    Name,
    Icon,
}

impl VaultText {
    fn associated_data(self, vault_id: &str) -> String {
        let prefix = match self {
            Self::Name => "vault-name-v1",
            Self::Icon => "vault-icon-v1",
        };
        format!("{prefix}:{vault_id}")
    }
}

/// `encryptedName`/`nameNonce` or `encryptedIcon`/`iconNonce`, standard base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedText {
    pub ciphertext: String,
    pub nonce: String,
}

pub fn seal(
    kind: VaultText,
    vault_key: &[u8],
    vault_id: &str,
    text: &str,
) -> Result<SealedText, CryptoError> {
    seal_with_nonce(
        kind,
        vault_key,
        vault_id,
        text,
        &sodium::random_bytes(NONCE_LEN),
    )
}

fn seal_with_nonce(
    kind: VaultText,
    vault_key: &[u8],
    vault_id: &str,
    text: &str,
    nonce: &[u8],
) -> Result<SealedText, CryptoError> {
    let associated_data = kind.associated_data(vault_id);
    let ciphertext = sodium::aead_encrypt(
        text.as_bytes(),
        Some(associated_data.as_bytes()),
        nonce,
        vault_key,
    )?;
    Ok(SealedText {
        ciphertext: base64_encode(&ciphertext),
        nonce: base64_encode(nonce),
    })
}

/// `None` for anything that does not open, as Electron answers `null`: a bad
/// name or icon must not break the vault list (§4.15). The text decodes as
/// Electron's `TextDecoder` does: invalid UTF-8 becomes U+FFFD and one leading
/// byte-order mark is dropped. The result is never longer than the ciphertext.
pub fn open(
    kind: VaultText,
    vault_key: &[u8],
    vault_id: &str,
    ciphertext: &str,
    nonce: &str,
) -> Option<String> {
    let ciphertext = base64_decode(ciphertext).ok()?;
    let nonce = base64_decode(nonce).ok()?;
    let associated_data = kind.associated_data(vault_id);
    let plaintext = sodium::aead_decrypt(
        &ciphertext,
        Some(associated_data.as_bytes()),
        &nonce,
        vault_key,
    )
    .ok()?;
    let text = String::from_utf8_lossy(&plaintext);
    Some(text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `vault-name` class's seals: under the fixed nonce, Electron's
    /// ciphertext byte for byte (`packages/contracts/test-vectors/vault-name.json`).
    #[test]
    fn vault_name_crypto_seals_reproduce_electron_bytes() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/contracts/test-vectors/vault-name.json"
        );
        let file: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("the vector file"))
                .expect("json");
        let text = |case: &serde_json::Value, key: &str| case[key].as_str().expect(key).to_owned();
        let key = hex::decode(text(&file, "keyHex")).expect("hex");
        let seals = file["seals"].as_array().expect("seals");
        assert_eq!(seals.len(), 9);
        for case in seals {
            let name = text(case, "name");
            let kind = match text(case, "kind").as_str() {
                "name" => VaultText::Name,
                "icon" => VaultText::Icon,
                other => panic!("unknown kind {other}"),
            };
            let nonce = hex::decode(text(case, "nonceHex")).expect("hex");
            let sealed = seal_with_nonce(
                kind,
                &key,
                &text(case, "vaultUuid"),
                &text(case, "plaintext"),
                &nonce,
            )
            .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(sealed.ciphertext, text(case, "ciphertextBase64"), "{name}");
            assert_eq!(sealed.nonce, text(case, "nonceBase64"), "{name}");
        }
    }
}

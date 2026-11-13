//! The agent at-rest envelope, chapter 04 §4.17: how desktop seals an agent
//! conversation's title and a message's content and attachments in its local
//! database (`apps/desktop/src/main/agent/storage/encryption.ts`).
//!
//! The sealed column holds the JSON text
//! `{"version":1,"nonce":<base64>,"ciphertext":<base64>}`, byte for byte what
//! Electron writes (`conversation-store.ts:53-58`, `message-store.ts:51-64`),
//! so a migration copies Electron's ciphertext unchanged. The cipher is
//! XChaCha20-Poly1305 under the vault key with the associated data
//! `memry/1/<purpose>`, so a title never opens as a message body.
//!
//! The wire never carries this envelope: the sync payload is plain JSON
//! inside the record envelope (§4.6). Only local storage seals.

use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::api::errors::CryptoError;
use crate::crypto::keys::{base64_decode, base64_encode};
use crate::crypto::sodium;

/// `AGENT_AT_REST_VERSION`.
pub const VERSION: u64 = 1;

const NONCE_LEN: usize = 24;

/// `AgentAtRestPurpose`: which column a plaintext belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    ConversationTitle,
    MessageContent,
    Attachments,
}

impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ConversationTitle => "agent_conversation_title",
            Self::MessageContent => "agent_message_content",
            Self::Attachments => "agent_attachments",
        }
    }

    fn associated_data(self) -> String {
        format!("memry/{VERSION}/{}", self.as_str())
    }
}

/// Why a seal or an open failed.
#[derive(Debug, thiserror::Error)]
pub enum SealError {
    /// No vault key is installed ([`AtRestKey::set`]).
    #[error("no at-rest key is installed")]
    KeyUnavailable,
    /// The column is not an envelope: not JSON, a missing or mistyped field,
    /// bad base64, or a nonce of the wrong length.
    #[error("not an agent envelope")]
    Malformed,
    /// An envelope of a version this build does not read.
    #[error("unsupported agent envelope version {0}")]
    UnsupportedVersion(u64),
    /// Authentication failed (wrong key, wrong purpose, altered bytes), or
    /// encryption failed.
    #[error(transparent)]
    Crypto(#[from] CryptoError),
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u64,
    nonce: String,
    ciphertext: String,
}

/// Seals `plaintext` for `purpose` under `key` with a fresh random nonce.
pub fn seal(purpose: Purpose, plaintext: &str, key: &[u8; 32]) -> Result<String, SealError> {
    seal_with_nonce(purpose, plaintext, key, &sodium::random_bytes(NONCE_LEN))
}

/// [`seal`] under a given nonce, for the conformance vectors. Production
/// callers use [`seal`]: a nonce reused under one key breaks the cipher.
#[doc(hidden)]
pub fn seal_with_nonce(
    purpose: Purpose,
    plaintext: &str,
    key: &[u8; 32],
    nonce: &[u8],
) -> Result<String, SealError> {
    let associated_data = purpose.associated_data();
    let ciphertext = sodium::aead_encrypt(
        plaintext.as_bytes(),
        Some(associated_data.as_bytes()),
        nonce,
        key,
    )?;
    let envelope = Envelope {
        version: VERSION,
        nonce: base64_encode(nonce),
        ciphertext: base64_encode(&ciphertext),
    };
    serde_json::to_string(&envelope).map_err(|_| SealError::Crypto(CryptoError::EncryptionFailed))
}

/// Opens an envelope [`seal`] or Electron wrote for `purpose`.
///
/// Invalid UTF-8 in the plaintext becomes U+FFFD, as Electron's `TextDecoder`
/// does; only a holder of the key can produce such a plaintext.
pub fn open(purpose: Purpose, envelope: &str, key: &[u8; 32]) -> Result<String, SealError> {
    let envelope: Envelope = serde_json::from_str(envelope).map_err(|_| SealError::Malformed)?;
    if envelope.version != VERSION {
        return Err(SealError::UnsupportedVersion(envelope.version));
    }
    let nonce = base64_decode(&envelope.nonce).map_err(|_| SealError::Malformed)?;
    let ciphertext = base64_decode(&envelope.ciphertext).map_err(|_| SealError::Malformed)?;
    if nonce.len() != NONCE_LEN {
        return Err(SealError::Malformed);
    }
    let associated_data = purpose.associated_data();
    let plaintext =
        sodium::aead_decrypt(&ciphertext, Some(associated_data.as_bytes()), &nonce, key)?;
    Ok(String::from_utf8_lossy(&plaintext).into_owned())
}

/// The vault key the agent stores seal under, shared by the [`Vault`] that
/// installs it and the writers that seal with it. Zeroed when replaced or
/// dropped.
///
/// [`Vault`]: crate::api::vault::Vault
#[derive(Clone, Default)]
pub struct AtRestKey(Arc<RwLock<Option<Zeroizing<[u8; 32]>>>>);

impl AtRestKey {
    /// Installs `key`, or removes the installed one with `None`.
    pub fn set(&self, key: Option<Zeroizing<[u8; 32]>>) {
        *self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = key;
    }

    /// [`seal`] under the installed key.
    pub fn seal(&self, purpose: Purpose, plaintext: &str) -> Result<String, SealError> {
        let key = self.key()?;
        seal(purpose, plaintext, &key)
    }

    /// [`open`] under the installed key.
    pub fn open(&self, purpose: Purpose, envelope: &str) -> Result<String, SealError> {
        let key = self.key()?;
        open(purpose, envelope, &key)
    }

    fn key(&self) -> Result<Zeroizing<[u8; 32]>, SealError> {
        let guard = self
            .0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or(SealError::KeyUnavailable)
    }
}

impl std::fmt::Debug for AtRestKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AtRestKey(..)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];

    #[test]
    fn a_sealed_text_opens_under_its_purpose_only() {
        let sealed = seal(Purpose::MessageContent, "hello", &KEY).unwrap();
        assert_eq!(
            open(Purpose::MessageContent, &sealed, &KEY).unwrap(),
            "hello"
        );
        assert!(matches!(
            open(Purpose::ConversationTitle, &sealed, &KEY),
            Err(SealError::Crypto(CryptoError::DecryptionFailed))
        ));
        assert!(matches!(
            open(Purpose::MessageContent, &sealed, &[8; 32]),
            Err(SealError::Crypto(CryptoError::DecryptionFailed))
        ));
    }

    #[test]
    fn two_seals_of_one_text_differ() {
        let a = seal(Purpose::Attachments, "[]", &KEY).unwrap();
        let b = seal(Purpose::Attachments, "[]", &KEY).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn a_column_that_is_not_an_envelope_is_malformed() {
        for column in [
            "",
            "plain title",
            r#"{"version":1,"nonce":"AAAA","ciphertext":"AAAA"}"#,
            r#"{"version":1,"nonce":"!!","ciphertext":"AAAA"}"#,
            r#"{"version":"1","nonce":"AAAA","ciphertext":"AAAA"}"#,
        ] {
            assert!(
                matches!(
                    open(Purpose::MessageContent, column, &KEY),
                    Err(SealError::Malformed)
                ),
                "{column:?}"
            );
        }
        assert!(matches!(
            open(
                Purpose::MessageContent,
                r#"{"version":2,"nonce":"","ciphertext":""}"#,
                &KEY
            ),
            Err(SealError::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn the_shared_key_seals_once_installed_and_stops_when_removed() {
        let key = AtRestKey::default();
        let writer = key.clone();
        assert!(matches!(
            writer.seal(Purpose::ConversationTitle, "t"),
            Err(SealError::KeyUnavailable)
        ));
        key.set(Some(Zeroizing::new(KEY)));
        let sealed = writer.seal(Purpose::ConversationTitle, "t").unwrap();
        assert_eq!(
            open(Purpose::ConversationTitle, &sealed, &KEY).unwrap(),
            "t"
        );
        key.set(None);
        assert!(matches!(
            writer.open(Purpose::ConversationTitle, &sealed),
            Err(SealError::KeyUnavailable)
        ));
        assert_eq!(format!("{key:?}"), "AtRestKey(..)");
    }
}

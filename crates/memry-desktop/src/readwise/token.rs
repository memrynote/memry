//! The Readwise access token in the keychain (`apps/desktop/src/main/readwise/secrets.ts`), and
//! connecting and disconnecting it (`connection.ts`). The connection is per vault, so the
//! account carries a hash of the vault path. The token never syncs and never enters settings.
//!
//! The service is `com.memrynote.memry.readwise`: Electron's `com.memry.readwise` is closed to
//! generic writes ([`crate::seams::secure_store`]) and is import material for the Electron
//! migration only.

use std::path::Path;
use std::sync::Arc;

use memry_core::api::errors::SecureStoreError;
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;

use super::client::{ReadwiseClient, ReadwiseError};
use crate::seams::secure_store::GenericSecrets;

pub const TOKEN_SERVICE: &str = "com.memrynote.memry.readwise";

/// `readwiseTokenAccountKey`: `token-<first 16 hex of sha256(vault path)>`, plus
/// `-<MEMRY_DEVICE>` when that is set, so two dev devices on one machine keep their own entry.
pub fn token_account(vault_path: &Path, device: Option<&str>) -> String {
    let hash = Sha256::digest(vault_path.to_string_lossy().as_bytes());
    let base = format!("token-{}", &hex::encode(hash)[..16]);
    match device {
        Some(device) if !device.is_empty() => format!("{base}-{device}"),
        _ => base,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("the Readwise token is empty")]
    Empty,
    #[error(transparent)]
    Readwise(#[from] ReadwiseError),
    #[error("the keychain did not store the Readwise token: {0}")]
    Keychain(#[from] SecureStoreError),
}

/// The token of one vault.
pub struct ReadwiseToken {
    secrets: Arc<dyn GenericSecrets>,
    account: String,
}

impl ReadwiseToken {
    /// `device` is the `MEMRY_DEVICE` value.
    pub fn new(secrets: Arc<dyn GenericSecrets>, vault_path: &Path, device: Option<&str>) -> Self {
        Self {
            secrets,
            account: token_account(vault_path, device),
        }
    }

    /// The stored token. Bytes that are not UTF-8 (no build writes them) read as absent, so a
    /// reconnect replaces them, as Electron's unreadable entry does. A locked keychain is an
    /// error, never "not connected".
    pub fn read(&self) -> Result<Option<String>, SecureStoreError> {
        let Some(bytes) = self.secrets.get_secret(TOKEN_SERVICE, &self.account)? else {
            return Ok(None);
        };
        match String::from_utf8(bytes) {
            Ok(token) => Ok(Some(token)),
            Err(_) => {
                tracing::warn!("the stored Readwise token is not UTF-8; reading it as absent");
                Ok(None)
            }
        }
    }

    /// Checks the pasted token with Readwise, then stores it trimmed. A token Readwise refuses,
    /// or a check that fails, leaves the keychain untouched.
    pub async fn connect(
        &self,
        client: &ReadwiseClient,
        pasted: &str,
        cancel: &CancellationToken,
    ) -> Result<(), ConnectError> {
        let token = pasted.trim();
        if token.is_empty() {
            return Err(ConnectError::Empty);
        }
        client.verify_token(token, cancel).await?;
        let (secrets, account) = (Arc::clone(&self.secrets), self.account.clone());
        let token = zeroize::Zeroizing::new(token.to_owned());
        // The keychain call blocks on its worker until its deadline.
        tokio::task::spawn_blocking(move || {
            secrets.set_secret(TOKEN_SERVICE, &account, token.as_bytes())
        })
        .await
        .map_err(|error| SecureStoreError::Failed {
            what: format!("the keychain write did not finish: {error}"),
        })??;
        Ok(())
    }

    /// Deletes the token. Notes, options and run state are the caller's.
    pub fn disconnect(&self) -> Result<(), SecureStoreError> {
        self.secrets.delete_secret(TOKEN_SERVICE, &self.account)
    }
}

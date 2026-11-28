//! The open vault's attachment transfer (#3535), built over the driver's
//! server vault and its signer directory, so a manifest a peer signed resolves
//! the way that peer's records do.

use std::sync::Arc;

use zeroize::Zeroizing;

use super::SyncDriver;
use crate::api::auth::AuthSession;
use crate::api::errors::{StorageError, SyncError};
use crate::crypto::keys;
use crate::protocol::account::DeviceSigner;
use crate::protocol::attachments::SignerResolver;
use crate::sync::attachments::transfer::{AttachmentTransfer, SanitizeName};

impl SyncDriver {
    /// A transfer for `session`, the session this driver was opened with.
    /// Its requests go through the session's client, not the driver's paused
    /// one: Electron keeps attachment transfers running while sync is paused.
    /// Fails [`SyncError::Locked`] once the master key is gone.
    pub fn attachment_transfer(
        &self,
        session: &AuthSession,
        sanitize: SanitizeName,
    ) -> Result<AttachmentTransfer, SyncError> {
        let master_key = Zeroizing::new(session.master_key()?.ok_or(SyncError::Locked)?);
        let vault_key = Zeroizing::new(keys::derive_vault_key(&master_key)?.to_vec());
        let signer = DeviceSigner::new(
            &session.registered_device_id()?,
            session.signing_secret_key()?,
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
        Ok(AttachmentTransfer::new(
            session.http(),
            &self.server_vault,
            vault_key,
            signer,
            Arc::clone(&self.cipher) as Arc<dyn SignerResolver>,
            sanitize,
        ))
    }
}

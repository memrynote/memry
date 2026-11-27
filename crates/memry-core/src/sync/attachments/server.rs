//! The server calls the revival check and the release runner make (#3535 S5):
//! an attachment's chunk hashes, the revived-note probe, a hold release and a
//! dereference. A borrowed view of what [`AttachmentTransfer`] already holds,
//! so the runners need no second copy of the vault key.

use super::holds::{self, AttachmentChunks, HoldOutcome};
use super::transfer::AttachmentTransfer;
use crate::api::errors::{ApiError, CryptoError};
use crate::protocol::attachment_upload;
use crate::protocol::attachments::{AttachmentError, SignerResolver, fetch_manifest};
use crate::protocol::http::HttpClient;

/// One vault's attachment routes.
#[derive(Clone, Copy)]
pub struct AttachmentServer<'a> {
    pub http: &'a HttpClient,
    pub vault_id: &'a str,
    pub vault_key: &'a [u8],
    pub signers: &'a dyn SignerResolver,
}

impl AttachmentTransfer {
    pub fn server(&self) -> AttachmentServer<'_> {
        AttachmentServer {
            http: &self.http,
            vault_id: &self.vault_id,
            vault_key: &self.vault_key,
            signers: self.signers.as_ref(),
        }
    }
}

impl AttachmentServer<'_> {
    /// The encrypted chunk hashes of `attachment_id`, or `None` when the server
    /// has no manifest for it (`getAttachmentChunkHashes` answering `[]`). Any
    /// other failure is an `Err`: the caller cannot tell gone from unreachable.
    pub async fn chunk_hashes(
        &self,
        attachment_id: &str,
    ) -> Result<Option<Vec<String>>, AttachmentError> {
        let fetched = fetch_manifest(
            self.http,
            self.vault_id,
            attachment_id,
            self.vault_key,
            self.signers,
        )
        .await;
        match fetched {
            Ok((manifest, _file_key)) => Ok(Some(
                manifest
                    .chunks
                    .into_iter()
                    .map(|chunk| chunk.encrypted_hash)
                    .collect(),
            )),
            Err(AttachmentError::Api(ApiError::Status { status: 404, .. })) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn probe_note(
        &self,
        note_id: &str,
        attachments: &[AttachmentChunks],
    ) -> Result<HoldOutcome, CryptoError> {
        holds::probe_note_attachments(
            self.http,
            self.vault_id,
            self.vault_key,
            note_id,
            attachments,
        )
        .await
    }

    pub async fn release_holds(&self, holder_ids: &[String]) -> Result<(), ApiError> {
        holds::release(self.http, self.vault_id, holder_ids).await
    }

    pub async fn dereference(&self, chunk_hashes: &[String]) -> Result<(), AttachmentError> {
        attachment_upload::dereference(self.http, self.vault_id, chunk_hashes).await
    }
}

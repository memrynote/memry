//! What one vault's attachment transfers share: the server, the keys, and the
//! presign memory (#3535). Desktop's `AttachmentSyncService`
//! (`apps/desktop/src/main/sync/attachments.ts:376`): one per signed-in vault,
//! so a deployment that answered "no presign" is not probed again on every
//! transfer.
//!
//! Keys are held here, in memory, for the life of the transfer object. Nothing
//! of them is written to disk: the download sidecar ([`super::resume`]) holds
//! only Electron's six progress fields.

use std::io;
use std::sync::Arc;

use zeroize::Zeroizing;

use super::presign::Presigner;
use crate::api::errors::{ApiError, StorageError};
use crate::protocol::account::DeviceSigner;
use crate::protocol::attachment_stream::StreamError;
use crate::protocol::attachments::{AttachmentError, SignerResolver};
use crate::protocol::http::HttpClient;

/// Makes a name safe for the file system: the vault's `sanitizeFilename`
/// (`vault/file-ops.ts:484`), which the shell owns and hands in.
pub type SanitizeName = fn(&str) -> String;

/// A vault's attachment uploads and downloads.
pub struct AttachmentTransfer {
    pub(super) http: Arc<HttpClient>,
    pub(super) vault_id: String,
    pub(super) vault_key: Zeroizing<Vec<u8>>,
    pub(super) signer: DeviceSigner,
    pub(super) signers: Arc<dyn SignerResolver>,
    pub(super) sanitize: SanitizeName,
    pub(super) presign: Presigner,
}

impl AttachmentTransfer {
    /// `signer` signs the manifests this device uploads; `signers` resolves
    /// the device that signed a manifest this device reads (§14.4.1).
    pub fn new(
        http: Arc<HttpClient>,
        vault_id: &str,
        vault_key: Zeroizing<Vec<u8>>,
        signer: DeviceSigner,
        signers: Arc<dyn SignerResolver>,
        sanitize: SanitizeName,
    ) -> Self {
        Self {
            http,
            vault_id: vault_id.to_owned(),
            vault_key,
            signer,
            signers,
            sanitize,
            presign: Presigner::default(),
        }
    }
}

/// Why a transfer failed.
#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error(transparent)]
    Attachment(#[from] AttachmentError),
    #[error("attachment file: {0}")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// `EmptyAttachmentError` (`errors:attachment.emptyFile`): fails the same
    /// way on every retry, so the queue drops the row.
    #[error("errors:attachment.emptyFile")]
    EmptyFile,
    /// `errors:attachment.exceedsMaxSize`, refused before a byte is read.
    #[error("errors:attachment.exceedsMaxSize ({size} bytes, limit {limit})")]
    TooLarge { size: u64, limit: u64 },
    /// The file's bytes differ between the pass that hashed it for `initiate`
    /// and the pass that uploads it. Nothing of the changed bytes left the
    /// device; the next attempt starts over.
    #[error("the file changed while it was uploading")]
    FileChanged,
    /// `errors:attachment.diskFull`: the verified prefix of a download stays
    /// for the next attempt.
    #[error("errors:attachment.diskFull")]
    DiskFull(#[source] io::Error),
}

impl From<StreamError> for TransferError {
    fn from(error: StreamError) -> Self {
        match error {
            StreamError::Io(error) => Self::Io(error),
            StreamError::Attachment(error) => Self::Attachment(error),
        }
    }
}

impl TransferError {
    /// A transport failure, a 429 or a 5xx (`isResumableDownloadError`,
    /// `attachments.ts:125`): the landed chunks are fine, only the network
    /// failed, so a download keeps its partial and an upload is retried
    /// rather than counted as a different file.
    pub fn is_resumable(&self) -> bool {
        match self {
            Self::Attachment(AttachmentError::Api(error)) => api_resumable(error),
            _ => false,
        }
    }
}

pub(super) fn api_resumable(error: &ApiError) -> bool {
    match error {
        ApiError::Transport { .. } | ApiError::RateLimited { .. } => true,
        ApiError::Status { status, .. } => *status >= 500,
        _ => false,
    }
}

/// `isDiskSpaceError` (`attachments.ts:140`): ENOSPC or EDQUOT.
pub(super) fn is_disk_full(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    )
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

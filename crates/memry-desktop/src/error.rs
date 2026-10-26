//! Core errors as the shell shows them: `{ kind, code, message }`.
//!
//! `memry-tauri` owns the wire type (`CommandError`) and its serializer; this crate cannot see
//! it, so [`map_core`] returns the same three fields and the adapter wraps them. `kind` comes
//! from the fixed set the renderer branches on, `code` is a stable snake_case reason, and the
//! message is the error's `Display`, which never carries secrets.

use memry_core::api::errors::{
    ApiError, AuthError, CryptoError, PropertyWriteError, SecureStoreError, StorageError,
    SyncError, TransportError,
};
use memry_core::crdt::errors::CrdtError;

/// The class of a failure. Mirrors `ErrorKind` of `memry-tauri`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Storage,
    Crypto,
    Auth,
    Api,
    Sync,
    Crdt,
    Recovery,
    PropertyWrite,
    SecureStore,
    Transport,
    Locked,
    NotFound,
    Invalid,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub kind: FailureKind,
    pub code: &'static str,
    pub message: String,
}

/// A core error that maps to a [`Failure`].
pub trait CoreError: std::fmt::Display {
    fn kind_and_code(&self) -> (FailureKind, &'static str);
}

pub fn map_core<E: CoreError>(error: &E) -> Failure {
    let (kind, code) = error.kind_and_code();
    Failure {
        kind,
        code,
        message: error.to_string(),
    }
}

impl CoreError for StorageError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        use FailureKind::{Invalid, Locked, NotFound, Recovery, Storage};
        match self {
            Self::NotOpen => (Locked, "storage_not_open"),
            Self::Migration { .. } => (Storage, "migration_failed"),
            Self::MissingFts5 => (Storage, "missing_fts5"),
            Self::IndexRebuildRequired { .. } => (Storage, "index_rebuild_required"),
            Self::OutOfSpace { .. } => (Storage, "out_of_space"),
            // The runtime corruption signal (`SQLITE_CORRUPT` from a query): the shell offers
            // the same repair as a failed open.
            Self::Failed { .. } if self.is_corrupt() => (Recovery, "storage_corrupt"),
            Self::Failed { .. } => (Storage, "storage_failed"),
            Self::NotFound { .. } => (NotFound, "not_found"),
            Self::Invalid { .. } => (Invalid, "invalid"),
            Self::Corrupt { .. } => (Recovery, "storage_corrupt"),
            Self::ForeignSchema { .. } => (Storage, "foreign_schema"),
        }
    }
}

impl CoreError for CryptoError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        let code = match self {
            Self::InvalidLength { .. } => "invalid_length",
            Self::InvalidParameter { .. } => "invalid_parameter",
            Self::DecryptionFailed => "decryption_failed",
            Self::EncryptionFailed => "encryption_failed",
            Self::OutOfMemory { .. } => "out_of_memory",
            Self::InvalidBase64 => "invalid_base64",
            Self::InvalidHex => "invalid_hex",
        };
        (FailureKind::Crypto, code)
    }
}

impl CoreError for SecureStoreError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Locked => (FailureKind::Locked, "secure_store_locked"),
            Self::Denied { .. } => (FailureKind::SecureStore, "secure_store_denied"),
            Self::Failed { .. } => (FailureKind::SecureStore, "secure_store_failed"),
        }
    }
}

impl CoreError for TransportError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        (FailureKind::Transport, "transport_failed")
    }
}

impl CoreError for ApiError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Transport { .. } => (FailureKind::Transport, "transport_failed"),
            Self::Storage { .. } => (FailureKind::Storage, "storage_failed"),
            Self::Unauthorized { .. } | Self::DeviceRevoked { .. } => {
                (FailureKind::Auth, "unauthorized")
            }
            _ => (FailureKind::Api, "api_error"),
        }
    }
}

impl CoreError for AuthError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Api { source } => source.kind_and_code(),
            Self::SecureStore { source } => source.kind_and_code(),
            Self::Crypto { source } => source.kind_and_code(),
            _ => (FailureKind::Auth, "auth_failed"),
        }
    }
}

impl CoreError for SyncError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Api { source } => source.kind_and_code(),
            Self::Storage { source } => source.kind_and_code(),
            Self::SecureStore { source } => source.kind_and_code(),
            Self::Crypto { source } => source.kind_and_code(),
            Self::Auth { source } => source.kind_and_code(),
            Self::Locked => (FailureKind::Locked, "device_locked"),
            Self::UnknownNote { .. } => (FailureKind::NotFound, "unknown_note"),
            Self::AttachmentUnverified { .. } => (FailureKind::Sync, "attachment_unverified"),
            Self::AttachmentCorrupt { .. } => (FailureKind::Sync, "attachment_corrupt"),
        }
    }
}

impl CoreError for CrdtError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::DocumentBusy { .. } => (FailureKind::Crdt, "document_busy"),
            Self::Undecodable { .. } => (FailureKind::Crdt, "undecodable_update"),
            Self::NotApplicable { .. } => (FailureKind::Crdt, "update_not_applicable"),
            Self::Storage { source } => source.kind_and_code(),
        }
    }
}

impl CoreError for PropertyWriteError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Retyped { .. } => (FailureKind::PropertyWrite, "property_retyped"),
            Self::Storage { source } => source.kind_and_code(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage(error: StorageError) -> (FailureKind, &'static str) {
        error.kind_and_code()
    }

    #[test]
    fn a_runtime_corruption_signal_is_the_recovery_error_and_other_failures_are_not() {
        let corrupt = StorageError::Failed {
            what: "database disk image is malformed".to_owned(),
        };
        assert_eq!(storage(corrupt), (FailureKind::Recovery, "storage_corrupt"));
        let busy = StorageError::Failed {
            what: "database is locked".to_owned(),
        };
        assert_eq!(storage(busy), (FailureKind::Storage, "storage_failed"));
    }

    #[test]
    fn every_storage_variant_has_its_own_code() {
        use FailureKind::{Invalid, Locked, NotFound, Recovery, Storage};
        let what = || "x".to_owned();
        let cases = [
            (StorageError::NotOpen, Locked, "storage_not_open"),
            (
                StorageError::Migration {
                    version: 3,
                    what: what(),
                },
                Storage,
                "migration_failed",
            ),
            (StorageError::MissingFts5, Storage, "missing_fts5"),
            (
                StorageError::IndexRebuildRequired { what: what() },
                Storage,
                "index_rebuild_required",
            ),
            (
                StorageError::OutOfSpace {
                    needed_bytes: 2,
                    available_bytes: 1,
                },
                Storage,
                "out_of_space",
            ),
            (
                StorageError::Failed { what: what() },
                Storage,
                "storage_failed",
            ),
            (
                StorageError::NotFound { what: what() },
                NotFound,
                "not_found",
            ),
            (StorageError::Invalid { what: what() }, Invalid, "invalid"),
            (
                StorageError::Corrupt { path: what() },
                Recovery,
                "storage_corrupt",
            ),
            (
                StorageError::ForeignSchema { path: what() },
                Storage,
                "foreign_schema",
            ),
        ];
        for (error, kind, code) in cases {
            assert_eq!(storage(error), (kind, code));
        }
    }

    #[test]
    fn the_message_is_the_display_text() {
        let failure = map_core(&StorageError::Corrupt {
            path: "/v/data.db".into(),
        });
        assert_eq!(
            failure.message,
            StorageError::Corrupt {
                path: "/v/data.db".into()
            }
            .to_string()
        );
    }

    #[test]
    fn wrapped_errors_keep_the_inner_classification() {
        let corrupt = StorageError::Corrupt { path: "p".into() };
        let sync = SyncError::Storage {
            source: corrupt.clone(),
        };
        assert_eq!(
            sync.kind_and_code(),
            (FailureKind::Recovery, "storage_corrupt")
        );
        assert_eq!(
            CrdtError::Storage {
                source: corrupt.clone()
            }
            .kind_and_code()
            .1,
            "storage_corrupt"
        );
        assert_eq!(
            PropertyWriteError::Storage { source: corrupt }
                .kind_and_code()
                .1,
            "storage_corrupt"
        );
        assert_eq!(
            SyncError::Locked.kind_and_code(),
            (FailureKind::Locked, "device_locked")
        );
        assert_eq!(
            SyncError::UnknownNote { id: "n".into() }.kind_and_code().0,
            FailureKind::NotFound
        );
        assert_eq!(
            SyncError::AttachmentUnverified {
                device_id: "d".into()
            }
            .kind_and_code()
            .0,
            FailureKind::Sync
        );
    }

    #[test]
    fn crypto_secure_store_and_api_errors_map() {
        assert_eq!(
            CryptoError::DecryptionFailed.kind_and_code(),
            (FailureKind::Crypto, "decryption_failed")
        );
        assert_eq!(
            SecureStoreError::Locked.kind_and_code(),
            (FailureKind::Locked, "secure_store_locked")
        );
        assert_eq!(
            SecureStoreError::Denied { what: "x".into() }.kind_and_code(),
            (FailureKind::SecureStore, "secure_store_denied")
        );
        assert_eq!(
            ApiError::Storage { what: "x".into() }.kind_and_code(),
            (FailureKind::Storage, "storage_failed")
        );
        assert_eq!(
            AuthError::SessionExpired.kind_and_code(),
            (FailureKind::Auth, "auth_failed")
        );
        assert_eq!(
            AuthError::SecureStore {
                source: SecureStoreError::Locked
            }
            .kind_and_code()
            .0,
            FailureKind::Locked
        );
    }
}

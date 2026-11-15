//! Which `SyncErrorCategory` a failed pass reports, as `apps/desktop/src/main/sync/sync-errors.ts`
//! names them. The renderer picks its copy and its action by the category, so a wrong one tells
//! the user to do the wrong thing (a paying user to pay, a revoked device to retry).

use memry_core::api::errors::{ApiError, AuthError, SyncError, TransportError};
use serde::Serialize;

/// `packages/contracts/src/ipc-sync-ops.ts` `SyncErrorCategory`, every member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncErrorCategory {
    NetworkOffline,
    NetworkTimeout,
    ServerError,
    AuthExpired,
    DeviceRevoked,
    RateLimited,
    CryptoFailure,
    VersionIncompatible,
    StorageQuotaExceeded,
    FileTooLarge,
    NoteTooLarge,
    SyncPaymentRequired,
    SyncVaultLimitExceeded,
    CertificatePinFailed,
    DeviceKeyMismatch,
    DeviceKeysMissing,
    KeychainUnavailable,
    Unknown,
}

impl SyncErrorCategory {
    pub const ALL: [Self; 18] = [
        Self::NetworkOffline,
        Self::NetworkTimeout,
        Self::ServerError,
        Self::AuthExpired,
        Self::DeviceRevoked,
        Self::RateLimited,
        Self::CryptoFailure,
        Self::VersionIncompatible,
        Self::StorageQuotaExceeded,
        Self::FileTooLarge,
        Self::NoteTooLarge,
        Self::SyncPaymentRequired,
        Self::SyncVaultLimitExceeded,
        Self::CertificatePinFailed,
        Self::DeviceKeyMismatch,
        Self::DeviceKeysMissing,
        Self::KeychainUnavailable,
        Self::Unknown,
    ];

    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NetworkOffline => "network_offline",
            Self::NetworkTimeout => "network_timeout",
            Self::ServerError => "server_error",
            Self::AuthExpired => "auth_expired",
            Self::DeviceRevoked => "device_revoked",
            Self::RateLimited => "rate_limited",
            Self::CryptoFailure => "crypto_failure",
            Self::VersionIncompatible => "version_incompatible",
            Self::StorageQuotaExceeded => "storage_quota_exceeded",
            Self::FileTooLarge => "file_too_large",
            Self::NoteTooLarge => "note_too_large",
            Self::SyncPaymentRequired => "sync_payment_required",
            Self::SyncVaultLimitExceeded => "sync_vault_limit_exceeded",
            Self::CertificatePinFailed => "certificate_pin_failed",
            Self::DeviceKeyMismatch => "device_key_mismatch",
            Self::DeviceKeysMissing => "device_keys_missing",
            Self::KeychainUnavailable => "keychain_unavailable",
            Self::Unknown => "unknown",
        }
    }

    pub fn of(error: &SyncError) -> Self {
        match error {
            SyncError::Api { source } => api(source),
            SyncError::Auth { source } => auth(source),
            SyncError::SecureStore { .. } => Self::KeychainUnavailable,
            SyncError::Crypto { .. }
            | SyncError::AttachmentUnverified { .. }
            | SyncError::AttachmentCorrupt { .. } => Self::CryptoFailure,
            SyncError::Locked => Self::DeviceKeysMissing,
            SyncError::Storage { .. } | SyncError::UnknownNote { .. } => Self::Unknown,
        }
    }
}

fn api(error: &ApiError) -> SyncErrorCategory {
    use SyncErrorCategory as C;
    match error {
        ApiError::Transport { source } => transport(source),
        ApiError::Unauthorized { .. } => C::AuthExpired,
        ApiError::DeviceRevoked { .. } => C::DeviceRevoked,
        ApiError::RateLimited { .. } => C::RateLimited,
        ApiError::UpgradeRequired { .. } => C::VersionIncompatible,
        ApiError::PaymentRequired { code, .. } => payment(code.as_deref()),
        ApiError::NoMasterKey => C::DeviceKeysMissing,
        ApiError::Status {
            status,
            code,
            message,
        } => status_category(*status, code.as_deref(), message),
        ApiError::Storage { .. } => C::Unknown,
        ApiError::InvalidClientIdentity { .. } => C::Unknown,
        // An HTTP failure with no narrower category is the server's (`sync-errors.ts` falls back
        // to `server_error` for every status it does not name).
        ApiError::DeviceLimitReached { .. }
        | ApiError::WritesDisabled { .. }
        | ApiError::BootstrapUnavailable
        | ApiError::MalformedResponse { .. }
        | ApiError::BillingPortalUnavailable { .. } => C::ServerError,
    }
}

fn status_category(status: u16, code: Option<&str>, message: &str) -> SyncErrorCategory {
    use SyncErrorCategory as C;
    let names = |wanted: &str| code == Some(wanted) || message.contains(wanted);
    match status {
        401 => C::AuthExpired,
        402 => payment(code),
        403 if names("AUTH_DEVICE_REVOKED") => C::DeviceRevoked,
        403 if names("SYNC_INVALID_SIGNATURE") => C::DeviceKeyMismatch,
        413 if names("STORAGE_FILE_TOO_LARGE") => C::FileTooLarge,
        413 if names("STORAGE_QUOTA_EXCEEDED") => C::StorageQuotaExceeded,
        413 => C::NoteTooLarge,
        426 => C::VersionIncompatible,
        429 => C::RateLimited,
        _ => C::ServerError,
    }
}

/// A 402 is either "no plan" or "a limit inside an active plan" (§11.7.1): reporting the second
/// as the first tells a paying user to pay again.
fn payment(code: Option<&str>) -> SyncErrorCategory {
    if code == Some("SYNC_VAULT_LIMIT_EXCEEDED") {
        SyncErrorCategory::SyncVaultLimitExceeded
    } else {
        SyncErrorCategory::SyncPaymentRequired
    }
}

fn transport(error: &TransportError) -> SyncErrorCategory {
    use SyncErrorCategory as C;
    match error {
        TransportError::Offline | TransportError::Failed { .. } | TransportError::Cancelled => {
            C::NetworkOffline
        }
        TransportError::Timeout { .. } => C::NetworkTimeout,
        TransportError::Tls { .. } => C::CertificatePinFailed,
        TransportError::SocketClosed { .. } | TransportError::HandshakeRejected { .. } => {
            C::ServerError
        }
    }
}

fn auth(error: &AuthError) -> SyncErrorCategory {
    match error {
        AuthError::Api { source } => api(source),
        AuthError::SecureStore { .. } => SyncErrorCategory::KeychainUnavailable,
        AuthError::Crypto { .. } => SyncErrorCategory::CryptoFailure,
        AuthError::SessionExpired | AuthError::RefreshBlocked { .. } => {
            SyncErrorCategory::AuthExpired
        }
        _ => SyncErrorCategory::Unknown,
    }
}

#[cfg(test)]
#[path = "error_category_tests.rs"]
mod tests;

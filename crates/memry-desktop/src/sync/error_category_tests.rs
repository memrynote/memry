use memry_core::api::errors::{
    ApiError, AuthError, CryptoError, SecureStoreError, StorageError, SyncError, TransportError,
};

use super::SyncErrorCategory as C;

fn api(error: ApiError) -> C {
    C::of(&SyncError::Api { source: error })
}

fn status(status: u16, code: Option<&str>) -> C {
    api(ApiError::Status {
        status,
        code: code.map(str::to_owned),
        message: String::new(),
    })
}

fn transport(error: TransportError) -> C {
    api(ApiError::Transport { source: error })
}

#[test]
fn http_statuses_map_as_sync_errors_ts_does() {
    assert_eq!(status(401, None), C::AuthExpired);
    assert_eq!(status(403, Some("AUTH_DEVICE_REVOKED")), C::DeviceRevoked);
    assert_eq!(
        status(403, Some("SYNC_INVALID_SIGNATURE")),
        C::DeviceKeyMismatch
    );
    assert_eq!(status(403, None), C::ServerError);
    assert_eq!(
        status(402, Some("SYNC_VAULT_LIMIT_EXCEEDED")),
        C::SyncVaultLimitExceeded
    );
    assert_eq!(
        status(402, Some("SYNC_PAYMENT_REQUIRED")),
        C::SyncPaymentRequired
    );
    assert_eq!(status(413, Some("STORAGE_FILE_TOO_LARGE")), C::FileTooLarge);
    assert_eq!(
        status(413, Some("STORAGE_QUOTA_EXCEEDED")),
        C::StorageQuotaExceeded
    );
    assert_eq!(
        status(413, Some("VALIDATION_BODY_TOO_LARGE")),
        C::NoteTooLarge
    );
    assert_eq!(status(426, None), C::VersionIncompatible);
    assert_eq!(status(429, None), C::RateLimited);
    assert_eq!(status(500, None), C::ServerError);
    assert_eq!(status(400, None), C::ServerError);
    // The server's code can arrive in the message only (`serverError?.includes(...)`).
    assert_eq!(
        api(ApiError::Status {
            status: 413,
            code: None,
            message: "STORAGE_QUOTA_EXCEEDED: out of space".into(),
        }),
        C::StorageQuotaExceeded
    );
}

#[test]
fn typed_api_errors_map_to_their_category() {
    let text = String::new;
    assert_eq!(
        api(ApiError::Unauthorized {
            code: text(),
            message: text()
        }),
        C::AuthExpired
    );
    assert_eq!(
        api(ApiError::DeviceRevoked { message: text() }),
        C::DeviceRevoked
    );
    assert_eq!(
        api(ApiError::RateLimited {
            retry_after_s: Some(3),
            message: text()
        }),
        C::RateLimited
    );
    assert_eq!(
        api(ApiError::UpgradeRequired {
            min_version: None,
            message: text()
        }),
        C::VersionIncompatible
    );
    assert_eq!(
        api(ApiError::PaymentRequired {
            code: None,
            message: text()
        }),
        C::SyncPaymentRequired
    );
    assert_eq!(
        api(ApiError::PaymentRequired {
            code: Some("SYNC_VAULT_LIMIT_EXCEEDED".into()),
            message: text()
        }),
        C::SyncVaultLimitExceeded
    );
    assert_eq!(api(ApiError::NoMasterKey), C::DeviceKeysMissing);
    assert_eq!(
        api(ApiError::WritesDisabled { message: text() }),
        C::ServerError
    );
    assert_eq!(
        api(ApiError::MalformedResponse {
            path: text(),
            what: text()
        }),
        C::ServerError
    );
    assert_eq!(api(ApiError::Storage { what: text() }), C::Unknown);
}

#[test]
fn transport_failures_are_network_or_pin_failures() {
    assert_eq!(transport(TransportError::Offline), C::NetworkOffline);
    assert_eq!(
        transport(TransportError::Failed {
            what: String::new()
        }),
        C::NetworkOffline
    );
    assert_eq!(transport(TransportError::Cancelled), C::NetworkOffline);
    assert_eq!(
        transport(TransportError::Timeout { elapsed_ms: 1 }),
        C::NetworkTimeout
    );
    assert_eq!(
        transport(TransportError::Tls {
            what: String::new()
        }),
        C::CertificatePinFailed
    );
}

#[test]
fn local_failures_name_the_keychain_the_keys_or_the_crypto() {
    assert_eq!(
        C::of(&SyncError::SecureStore {
            source: SecureStoreError::Locked
        }),
        C::KeychainUnavailable
    );
    assert_eq!(C::of(&SyncError::Locked), C::DeviceKeysMissing);
    assert_eq!(
        C::of(&SyncError::Crypto {
            source: CryptoError::DecryptionFailed
        }),
        C::CryptoFailure
    );
    assert_eq!(
        C::of(&SyncError::AttachmentUnverified {
            device_id: String::new()
        }),
        C::CryptoFailure
    );
    assert_eq!(
        C::of(&SyncError::AttachmentCorrupt {
            what: String::new()
        }),
        C::CryptoFailure
    );
    assert_eq!(
        C::of(&SyncError::Auth {
            source: AuthError::SessionExpired
        }),
        C::AuthExpired
    );
    assert_eq!(
        C::of(&SyncError::Auth {
            source: AuthError::RefreshBlocked { retry_in_ms: 1 }
        }),
        C::AuthExpired
    );
    assert_eq!(
        C::of(&SyncError::Storage {
            source: StorageError::Failed {
                what: String::new()
            }
        }),
        C::Unknown
    );
}

/// The Rust enum and `SyncErrorCategory` in `ipc-sync-ops.ts` name the same members.
#[test]
fn the_enum_matches_the_contract_union() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/src/ipc-sync-ops.ts"
    );
    let source = std::fs::read_to_string(path).expect("ipc-sync-ops.ts");
    let start = source
        .find("export type SyncErrorCategory =")
        .expect("the union");
    let mut contract = Vec::new();
    for line in source[start..].lines().skip(1) {
        let line = line.trim();
        if line.starts_with("//") {
            continue;
        }
        let Some(member) = line.strip_prefix("| '") else {
            break;
        };
        contract.push(member.trim_end_matches('\'').to_owned());
    }
    let ours: Vec<String> = C::ALL.iter().map(|c| c.as_str().to_owned()).collect();
    assert_eq!(ours, contract);
    for category in C::ALL {
        assert_eq!(
            serde_json::to_value(category).unwrap(),
            serde_json::Value::String(category.as_str().to_owned())
        );
    }
}

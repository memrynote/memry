//! The two routes of §3.1 that belong to the **new device**, and nothing else.
//!
//! | Route                          | Auth     | Whose            |
//! | ------------------------------ | -------- | ---------------- |
//! | `POST /auth/linking/scan`      | **none** | the new device   |
//! | `POST /auth/linking/complete`  | **none** | the new device   |
//!
//! `initiate`, `GET /session/:sessionId` and `approve` are the already-unlocked
//! device's, are access-token authenticated, and are deliberately absent: a
//! phone that could call `approve` would be approving its own link.
//!
//! **Both of these are unauthenticated on purpose** (§3.1): the new device has
//! no session yet, and the `linkingSecret` carried in the QR is what authorises
//! them. They therefore use [`Auth::None`] and never the session path, which
//! matters beyond tidiness — an `Auth::Session` request with no token triggers
//! the 401 refresh-and-replay ladder, so a linking call that went through it
//! would spend a refresh on every poll of a device that has nothing to refresh.

use serde::Serialize;
use serde_json::Value as Json;

use super::{LinkingError, MasterKeyBlock};
use crate::api::errors::ApiError;
use crate::protocol::http::{ApiRequest, Auth, HttpClient, RetryPolicy};

pub const SCAN_PATH: &str = "/auth/linking/scan";
pub const COMPLETE_PATH: &str = "/auth/linking/complete";

/// §3.12's `LINKING_INVALID_TRANSITION`: on `complete` it is "the call arrived
/// out of order; keep polling", not a failure.
pub const LINKING_INVALID_TRANSITION: &str = "LINKING_INVALID_TRANSITION";

/// The `POST /auth/linking/scan` body.
///
/// Five of the six fields are derived; `linking_secret_b64` is the **string
/// from the QR, echoed byte-exact** (§3.3). Both scan-channel tags and the
/// confirm-channel tag ride in this one body — §3.7's most missable fact is
/// that `scan_proof` and `new_device_confirm` cover *identical* CBOR bytes
/// under different keys and different primitives.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub session_id: String,
    pub new_device_public_key: String,
    /// Confirm channel, `LINKING_PROOF`, `crypto_auth` under `memrymac`.
    pub new_device_confirm: String,
    pub linking_secret: String,
    /// Scan channel, `SCAN_CONFIRM`, HMAC-SHA-256 under the decoded secret.
    pub scan_confirm: String,
    /// Scan channel, `LINKING_PROOF`, HMAC-SHA-256 under the decoded secret.
    pub scan_proof: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteRequest<'a> {
    session_id: &'a str,
}

/// One of the two optional encrypted blocks of §3.10, as it arrives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedBlock {
    pub ciphertext_b64: String,
    pub nonce_b64: String,
    pub confirm_b64: String,
}

/// What an approved `complete` carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovedLink {
    pub master_key: MasterKeyBlock,
    pub key_confirm_b64: String,
    /// §3.10: absent means the initiator sent none, and the client proceeds
    /// with an empty vault list. Present and failing is a **hard** failure, and
    /// that decision belongs to the caller, not to this reader.
    pub vault_transfer: Option<EncryptedBlock>,
}

/// The answer to one `complete`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompleteOutcome {
    /// The initiator has not approved yet. The poll continues.
    NotYetApproved,
    Approved(Box<ApprovedLink>),
}

/// `POST /auth/linking/scan`, §3.1.
pub async fn scan(http: &HttpClient, request: &ScanRequest) -> Result<(), LinkingError> {
    let _: Json = http
        .send_json(ApiRequest::post(SCAN_PATH).json(request).auth(Auth::None))
        .await?;
    Ok(())
}

/// **One** `POST /auth/linking/complete`, §3.1.
///
/// Exactly one request per call, by [`RetryPolicy::never`]. §3.9 spells the
/// desktop's ladder as `{ maxRetries: 3, baseDelayMs: 2000, retryOn429: false }`
/// "because the poll cadence is itself the retry" — and here the poll cadence
/// belongs to the shell's timer, so folding a second ladder inside one call
/// would buy nothing and cost two things that matter on a phone. It would make
/// the per-session budget unaccountable, because §3.4's 30-requests-per-60-s
/// limit counts *requests* and an internal ladder issues up to four per call
/// with no way for the caller to know. And it would suspend an **uncancellable**
/// async call for up to 14 s (spec-defect 108): `rust_future_cancel` does not
/// appear in the bindings, so a user who walks away from a linking screen
/// cannot abandon a sleep the core is holding.
pub async fn complete(
    http: &HttpClient,
    session_id: &str,
) -> Result<CompleteOutcome, LinkingError> {
    let request = ApiRequest::post(COMPLETE_PATH)
        .json(&CompleteRequest { session_id })
        .auth(Auth::None)
        .retry(RetryPolicy::never());

    let body: Json = match http.send_json(request).await {
        Ok(body) => body,
        // §3.12: 409 on `complete` means the initiator has not approved yet.
        // It is the ordinary answer to all but the last poll, and reporting it
        // as a failure is what would make a working link look broken.
        Err(ApiError::Status {
            status: 409,
            code: Some(code),
            ..
        }) if code == LINKING_INVALID_TRANSITION => return Ok(CompleteOutcome::NotYetApproved),
        Err(error) => return Err(error.into()),
    };

    read_approved(&body).map(|link| CompleteOutcome::Approved(Box::new(link)))
}

/// A 200 that carries no master key block is a **malformed response**, never an
/// empty answer: the route returns the block or it has not completed, and
/// treating a missing block as "nothing to do" would leave a device that
/// believes it is linked holding no key at all.
fn read_approved(body: &Json) -> Result<ApprovedLink, LinkingError> {
    let (Some(encrypted_master_key_b64), Some(encrypted_key_nonce_b64), Some(key_confirm_b64)) = (
        text(body, "encryptedMasterKey"),
        text(body, "encryptedKeyNonce"),
        text(body, "keyConfirm"),
    ) else {
        return Err(ApiError::MalformedResponse {
            path: COMPLETE_PATH.to_string(),
            what:
                "a completed link carried no { encryptedMasterKey, encryptedKeyNonce, keyConfirm }"
                    .to_string(),
        }
        .into());
    };

    Ok(ApprovedLink {
        master_key: MasterKeyBlock {
            encrypted_master_key_b64,
            encrypted_key_nonce_b64,
        },
        key_confirm_b64,
        vault_transfer: read_block(
            body,
            "encryptedVaultTransfer",
            "encryptedVaultTransferNonce",
            "vaultTransferConfirm",
        ),
    })
}

/// §3.10: the server stores an optional block only when **all** of that block's
/// fields are present, so a partial block is treated as absent here rather than
/// half-verified.
fn read_block(body: &Json, ciphertext: &str, nonce: &str, confirm: &str) -> Option<EncryptedBlock> {
    Some(EncryptedBlock {
        ciphertext_b64: text(body, ciphertext)?,
        nonce_b64: text(body, nonce)?,
        confirm_b64: text(body, confirm)?,
    })
}

fn text(body: &Json, name: &str) -> Option<String> {
    body.get(name).and_then(Json::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_approved_body_without_the_optional_block_is_still_approved() {
        let link = read_approved(&json!({
            "success": true,
            "encryptedMasterKey": "Y3Q=",
            "encryptedKeyNonce": "bm9uY2U=",
            "keyConfirm": "dGFn",
        }))
        .expect("approved");
        assert_eq!(link.vault_transfer, None);
        assert_eq!(link.master_key.encrypted_master_key_b64, "Y3Q=");
    }

    /// §3.10: all four fields or none. A half-block is absent, not a block
    /// whose MAC is about to be checked against a missing tag.
    #[test]
    fn a_partial_vault_transfer_block_reads_as_absent() {
        let link = read_approved(&json!({
            "encryptedMasterKey": "Y3Q=",
            "encryptedKeyNonce": "bm9uY2U=",
            "keyConfirm": "dGFn",
            "encryptedVaultTransfer": "dHJhbnNmZXI=",
        }))
        .expect("approved");
        assert_eq!(link.vault_transfer, None);
    }

    #[test]
    fn a_success_with_no_master_key_is_malformed_and_not_an_empty_link() {
        assert!(matches!(
            read_approved(&json!({ "success": true })),
            Err(LinkingError::Api {
                source: ApiError::MalformedResponse { .. }
            })
        ));
    }
}

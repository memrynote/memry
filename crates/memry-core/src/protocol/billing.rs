//! Purchases and vault attachment: the account routes a free, local-first
//! device calls when the user signs in, attaches a local vault, or buys.
//!
//! | Route                                         | Server                     |
//! | --------------------------------------------- | -------------------------- |
//! | `POST /sync/vaults`                           | `routes/sync.ts:133`       |
//! | `POST /auth/checkout-token`                   | `routes/auth.ts:812`       |
//! | `POST /auth/billing/reconcile`                | `routes/auth.ts:843`       |
//! | `POST /auth/billing/portal-session`           | `routes/auth.ts:864`       |
//! | `POST /auth/billing/app-store/transactions`   | App Store billing (new)    |
//!
//! The three billing routes that answer with a status answer with the
//! `GET /auth/billing` shape, read by [`account_admin::read_billing`].

use serde_json::{Value as Json, json};

use crate::api::errors::ApiError;
use crate::crypto::{keys, sodium};
use crate::protocol::account_admin::{self, BillingStatus, segment};
use crate::protocol::http::{ApiRequest, Auth, HttpClient};

/// XChaCha20-Poly1305 nonce length (chapter 04 §4.3).
const NAME_NONCE_BYTES: usize = 24;

/// A signed token the web checkout trusts in place of a web session.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CheckoutToken {
    pub token: String,
    /// Epoch seconds.
    pub expires_at: i64,
}

fn malformed(path: &str, what: &str) -> ApiError {
    ApiError::MalformedResponse {
        path: path.to_string(),
        what: what.to_string(),
    }
}

fn local(what: impl std::fmt::Display) -> ApiError {
    ApiError::Storage {
        what: what.to_string(),
    }
}

/// Seals a vault name exactly as desktop does
/// (`apps/desktop/src/main/sync/vault-name-crypto.ts:46-53`): XChaCha20-Poly1305
/// under the vault key (chapter 01 §1.6), `vault-name-v1:<vaultUuid>` as
/// associated data, ciphertext and nonce in standard base64.
pub(crate) fn seal_vault_name(
    master_key: &[u8],
    vault_id: &str,
    name: &str,
) -> Result<(String, String), ApiError> {
    let key = keys::derive_vault_key(master_key).map_err(local)?;
    let nonce = sodium::random_bytes(NAME_NONCE_BYTES);
    let aad = format!("vault-name-v1:{vault_id}");
    let sealed =
        sodium::aead_encrypt(name.as_bytes(), Some(aad.as_bytes()), &nonce, &key).map_err(local)?;
    Ok((keys::base64_encode(&sealed), keys::base64_encode(&nonce)))
}

/// `POST /sync/vaults`. The route upserts, so a vault already registered
/// answers `200` and its name is refreshed. A `409` is treated as the same
/// success for servers that refuse a duplicate instead. A `402` (no plan, or
/// `SYNC_VAULT_LIMIT_EXCEEDED`) is [`ApiError::PaymentRequired`].
pub async fn register_vault(
    http: &HttpClient,
    master_key: &[u8],
    vault_id: &str,
    name: &str,
) -> Result<(), ApiError> {
    let vault_id = segment(vault_id)?;
    let (encrypted_name, name_nonce) = seal_vault_name(master_key, vault_id, name)?;
    let request = ApiRequest::new("POST", "/sync/vaults")
        .auth(Auth::Session)
        .json(&json!({
            "vaultUuid": vault_id,
            "encryptedName": encrypted_name,
            "nameNonce": name_nonce,
        }));
    match http.send_json::<Json>(request).await {
        Ok(_) | Err(ApiError::Status { status: 409, .. }) => Ok(()),
        Err(ApiError::Status {
            status: 402,
            code,
            message,
        }) => Err(ApiError::PaymentRequired { code, message }),
        Err(error) => Err(error),
    }
}

async fn billing_post(
    http: &HttpClient,
    path: &str,
    body: Json,
) -> Result<BillingStatus, ApiError> {
    let body: Json = http
        .send_json(
            ApiRequest::new("POST", path)
                .auth(Auth::Session)
                .json(&body),
        )
        .await?;
    account_admin::read_billing(&body)
        .ok_or_else(|| malformed(path, "expected { plan, status, limits }"))
}

/// `POST /auth/billing/app-store/transactions` with the StoreKit 2
/// `jwsRepresentation`. The server verifies it with Apple and answers with the
/// account's billing status.
pub async fn submit_app_store_transaction(
    http: &HttpClient,
    signed_transaction_info: &str,
) -> Result<BillingStatus, ApiError> {
    billing_post(
        http,
        "/auth/billing/app-store/transactions",
        json!({ "signedTransactionInfo": signed_transaction_info }),
    )
    .await
}

/// `POST /auth/billing/reconcile` with no transaction: re-reads the
/// entitlement, as desktop's refresh does.
pub async fn refresh_billing(http: &HttpClient) -> Result<BillingStatus, ApiError> {
    billing_post(http, "/auth/billing/reconcile", json!({})).await
}

pub(crate) fn read_checkout_token(body: &Json) -> Option<CheckoutToken> {
    let checkout = body.get("checkoutToken")?.as_str()?.to_owned();
    Some(CheckoutToken {
        token: checkout,
        expires_at: body.get("expiresAt")?.as_i64()?,
    })
}

/// `POST /auth/checkout-token` → `{ checkoutToken, expiresAt }`.
pub async fn checkout_token(http: &HttpClient) -> Result<CheckoutToken, ApiError> {
    let body: Json = http
        .send_json(
            ApiRequest::new("POST", "/auth/checkout-token")
                .auth(Auth::Session)
                .json(&json!({})),
        )
        .await?;
    read_checkout_token(&body).ok_or_else(|| {
        malformed(
            "/auth/checkout-token",
            "expected { checkoutToken, expiresAt }",
        )
    })
}

/// `POST /auth/billing/portal-session` → `{ portalUrl }`. A `409` (no web
/// billing customer) is [`ApiError::BillingPortalUnavailable`].
pub async fn billing_portal_url(http: &HttpClient) -> Result<String, ApiError> {
    const PATH: &str = "/auth/billing/portal-session";
    let request = ApiRequest::new("POST", PATH)
        .auth(Auth::Session)
        .json(&json!({}));
    let body: Json = match http.send_json(request).await {
        Ok(body) => body,
        Err(ApiError::Status {
            status: 409,
            message,
            ..
        }) => return Err(ApiError::BillingPortalUnavailable { message }),
        Err(error) => return Err(error),
    };
    body.get("portalUrl")
        .and_then(Json::as_str)
        .filter(|url| url.starts_with("https://"))
        .map(str::to_owned)
        .ok_or_else(|| malformed(PATH, "expected { portalUrl: https://… }"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_name_opens_with_the_reader_desktop_names_share() {
        let master = vec![5u8; 32];
        let (sealed, nonce) = seal_vault_name(&master, "v-1", "Phone").expect("seal");
        assert_eq!(
            crate::api::crypto::decrypt_vault_name(
                master.clone(),
                "v-1".into(),
                sealed.clone(),
                nonce.clone()
            )
            .as_deref(),
            Some("Phone")
        );
        assert_eq!(
            crate::api::crypto::decrypt_vault_name(master, "v-2".into(), sealed, nonce),
            None
        );
    }

    #[test]
    fn a_checkout_token_needs_both_fields() {
        let token =
            read_checkout_token(&json!({"checkoutToken":"t.s","expiresAt":9})).expect("token");
        assert_eq!((token.token.as_str(), token.expires_at), ("t.s", 9));
        assert!(read_checkout_token(&json!({"checkoutToken":"t.s"})).is_none());
    }
}

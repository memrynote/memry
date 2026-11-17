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
//! | `GET /auth/billing`                           | `routes/auth.ts:851`       |
//! | `POST /auth/billing/change-plan/preview`      | `routes/auth.ts:888`       |
//! | `POST /auth/billing/change-plan`              | `routes/auth.ts:898`       |
//!
//! The billing routes that answer with a status answer with the
//! `GET /auth/billing` shape. The UniFFI routes read it as the flat
//! [`BillingStatus`] ([`account_admin::read_billing`]); desktop's Rust-only
//! routes read it as [`BillingSnapshot`], which keeps an unlimited vault count.

use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

use crate::api::crypto::encrypt_vault_name;
use crate::api::errors::ApiError;
use crate::protocol::account_admin::{self, BillingStatus, int, segment, text};
use crate::protocol::http::{ApiRequest, Auth, HttpClient};

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
    let sealed = encrypt_vault_name(master_key, vault_id, name).map_err(local)?;
    let request = ApiRequest::new("POST", "/sync/vaults")
        .auth(Auth::Session)
        .json(&json!({
            "vaultUuid": vault_id,
            "encryptedName": sealed.ciphertext,
            "nameNonce": sealed.nonce,
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

/// The `GET /auth/billing` shape as desktop's renderer reads it
/// (`apps/desktop/src/main/billing/paddle-billing.ts:45-62`). Rust-only: the
/// UniFFI [`BillingStatus`] that iOS constructs reads a `null` `maxVaults` as
/// `0`, which would show a Believer account as allowed no vault at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BillingSnapshot {
    /// `free`, `plus`, `pro` or `believer`; kept as the server sends it.
    pub plan: String,
    /// `monthly`, `annual` or `lifetime`; `None` on entitlements written
    /// before the server tracked cadence.
    pub cadence: Option<String>,
    /// `inactive`, `active`, `past_due`, `paused` or `canceled`.
    pub status: String,
    pub email: Option<String>,
    /// Bytes. No value exceeds 2^53 (the largest is 50 GB), so the renderer
    /// reads it exactly as a JavaScript number.
    pub storage_limit: i64,
    pub max_file_size: i64,
    /// `None` is unlimited: the server answers `null` for Believer
    /// (`services/entitlements.ts:52-75`).
    pub max_vaults: Option<i64>,
    pub version_history_days: i64,
    pub storage_used: i64,
    /// Epoch seconds.
    pub expires_at: Option<i64>,
    /// The account has a web billing customer, so the portal can open. An
    /// older server omits it, and the renderer then disables manage billing.
    pub can_manage_billing: bool,
}

/// Reads a `GET /auth/billing` body. `None` when `plan`, `status` or `limits`
/// is missing, or when `maxVaults` is neither a number nor `null`.
pub fn read_billing_snapshot(body: &Json) -> Option<BillingSnapshot> {
    let limits = body.get("limits")?;
    let max_vaults = match limits.get("maxVaults") {
        None | Some(Json::Null) => None,
        Some(_) => Some(int(limits, "maxVaults")?),
    };
    Some(BillingSnapshot {
        plan: text(body, "plan")?,
        cadence: text(body, "cadence"),
        status: text(body, "status")?,
        email: text(body, "email"),
        storage_limit: int(limits, "storageLimit").unwrap_or(0),
        max_file_size: int(limits, "maxFileSize").unwrap_or(0),
        max_vaults,
        version_history_days: int(limits, "versionHistoryDays").unwrap_or(0),
        storage_used: body
            .get("usage")
            .and_then(|usage| int(usage, "storageUsed"))
            .unwrap_or(0),
        expires_at: int(body, "expiresAt"),
        can_manage_billing: body
            .get("canManageBilling")
            .and_then(Json::as_bool)
            .unwrap_or(false),
    })
}

/// The recurring plans a subscription can switch between. Believer is a
/// one-time purchase with nothing to switch (`paddle-billing.ts:27-31`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanChangeTier {
    Plus,
    Pro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanChangeCadence {
    Monthly,
    Annual,
}

/// The body of both change-plan routes: `{ plan, cadence }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanChangeTarget {
    pub plan: PlanChangeTier,
    pub cadence: PlanChangeCadence,
}

/// When a plan change takes effect: an upgrade bills the prorated difference
/// now, a downgrade waits for renewal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanChangeEffective {
    Immediate,
    NextBillingPeriod,
}

/// `POST /auth/billing/change-plan/preview`'s answer
/// (`apps/sync-server/src/services/paddle-billing.ts:216-227`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangePreview {
    pub plan: PlanChangeTier,
    pub cadence: PlanChangeCadence,
    pub is_upgrade: bool,
    pub effective: PlanChangeEffective,
    /// Minor units (cents) as Paddle reports them; `None` when nothing is
    /// charged today.
    pub immediate_charge_amount: Option<String>,
    pub recurring_amount: String,
    pub currency_code: String,
    pub next_billed_at: Option<String>,
}

async fn snapshot_request(
    http: &HttpClient,
    request: ApiRequest,
) -> Result<BillingSnapshot, ApiError> {
    let path = request.path.clone();
    let body: Json = http.send_json(request).await?;
    read_billing_snapshot(&body)
        .ok_or_else(|| malformed(&path, "expected { plan, status, limits }"))
}

/// `GET /auth/billing`.
pub async fn billing_snapshot(http: &HttpClient) -> Result<BillingSnapshot, ApiError> {
    snapshot_request(http, ApiRequest::get("/auth/billing").auth(Auth::Session)).await
}

/// `POST /auth/billing/reconcile`, with `{ transactionId }` when the web
/// checkout handed one back and `{}` otherwise (`paddle-billing.ts:93-105`).
pub async fn reconcile(
    http: &HttpClient,
    transaction_id: Option<&str>,
) -> Result<BillingSnapshot, ApiError> {
    let body = match transaction_id.filter(|id| !id.is_empty()) {
        Some(id) => json!({ "transactionId": id }),
        None => json!({}),
    };
    snapshot_request(
        http,
        ApiRequest::new("POST", "/auth/billing/reconcile")
            .auth(Auth::Session)
            .json(&body),
    )
    .await
}

/// `POST /auth/billing/change-plan/preview`: what switching to `target`
/// would charge, without changing anything.
pub async fn preview_plan_change(
    http: &HttpClient,
    target: PlanChangeTarget,
) -> Result<PlanChangePreview, ApiError> {
    http.send_json(
        ApiRequest::new("POST", "/auth/billing/change-plan/preview")
            .auth(Auth::Session)
            .json(&target),
    )
    .await
}

/// `POST /auth/billing/change-plan`: switches the existing subscription and
/// answers with the new billing status.
pub async fn change_plan(
    http: &HttpClient,
    target: PlanChangeTarget,
) -> Result<BillingSnapshot, ApiError> {
    snapshot_request(
        http,
        ApiRequest::new("POST", "/auth/billing/change-plan")
            .auth(Auth::Session)
            .json(&target),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_checkout_token_needs_both_fields() {
        let token =
            read_checkout_token(&json!({"checkoutToken":"t.s","expiresAt":9})).expect("token");
        assert_eq!((token.token.as_str(), token.expires_at), ("t.s", 9));
        assert!(read_checkout_token(&json!({"checkoutToken":"t.s"})).is_none());
    }

    fn snapshot(limits: Json) -> Option<BillingSnapshot> {
        read_billing_snapshot(
            &json!({"plan":"believer","cadence":"lifetime","status":"active",
            "email":"k@example.com","limits":limits,"usage":{"storageUsed":7},"expiresAt":null}),
        )
    }

    #[test]
    fn a_believer_null_max_vaults_is_unlimited() {
        let believer = snapshot(
            json!({"storageLimit":53_687_091_200_i64,"maxFileSize":209_715_200,
            "maxVaults":null,"versionHistoryDays":365}),
        )
        .expect("snapshot");
        assert_eq!(believer.max_vaults, None);
        assert_eq!(believer.storage_limit, 53_687_091_200);
        assert_eq!((believer.storage_used, believer.expires_at), (7, None));
        // An older server without `canManageBilling` disables manage billing.
        assert!(!believer.can_manage_billing);
        // The flat UniFFI record keeps its `0` for iOS.
        let flat = account_admin::read_billing(&json!({"plan":"believer","status":"active",
            "limits":{"maxVaults":null}}))
        .expect("flat");
        assert_eq!(flat.max_vaults, 0);
    }

    #[test]
    fn max_vaults_missing_is_unlimited_and_a_number_is_kept() {
        assert_eq!(snapshot(json!({})).expect("snapshot").max_vaults, None);
        assert_eq!(
            snapshot(json!({"maxVaults":10}))
                .expect("snapshot")
                .max_vaults,
            Some(10)
        );
        assert_eq!(snapshot(json!({"maxVaults":"10"})), None);
    }

    #[test]
    fn a_snapshot_needs_plan_status_and_limits() {
        let full = json!({"plan":"plus","status":"active","limits":{},"canManageBilling":true});
        let read = read_billing_snapshot(&full).expect("snapshot");
        assert!(read.can_manage_billing);
        assert_eq!((read.cadence, read.email), (None, None));
        for key in ["plan", "status", "limits"] {
            let mut body = full.clone();
            body.as_object_mut().expect("object").remove(key);
            assert_eq!(read_billing_snapshot(&body), None, "without {key}");
        }
    }

    #[test]
    fn a_plan_change_target_serializes_as_the_server_schema() {
        let target = PlanChangeTarget {
            plan: PlanChangeTier::Pro,
            cadence: PlanChangeCadence::Annual,
        };
        assert_eq!(
            serde_json::to_value(target).expect("json"),
            json!({"plan":"pro","cadence":"annual"})
        );
    }

    #[test]
    fn a_preview_reads_the_camel_case_fields() {
        let preview: PlanChangePreview = serde_json::from_value(json!({"plan":"plus",
            "cadence":"annual","isUpgrade":true,"effective":"next_billing_period",
            "immediateChargeAmount":null,"recurringAmount":"4800","currencyCode":"USD"}))
        .expect("preview");
        assert_eq!(preview.effective, PlanChangeEffective::NextBillingPeriod);
        assert_eq!(
            (preview.immediate_charge_amount, preview.next_billed_at),
            (None, None)
        );
        assert!(
            serde_json::from_value::<PlanChangePreview>(json!({"plan":"believer",
                "cadence":"annual","isUpgrade":true,"effective":"immediate",
                "recurringAmount":"1","currencyCode":"USD"}))
            .is_err()
        );
    }
}

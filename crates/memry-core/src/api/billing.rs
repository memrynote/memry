//! Attaching a local vault to the account, and buying sync: the
//! [`AuthSession`] methods a device that started without an account calls once
//! it signs in. Wire shapes live in [`crate::protocol::billing`].

use zeroize::Zeroizing;

use crate::api::auth::AuthSession;
use crate::api::errors::ApiError;
use crate::protocol::account_admin::BillingStatus;
use crate::protocol::billing::{
    self, BillingSnapshot, CheckoutToken, PlanChangePreview, PlanChangeTarget,
};

#[uniffi::export(async_runtime = "tokio")]
impl AuthSession {
    /// `POST /sync/vaults`: adds a vault this device created locally to the
    /// account, as a vault of its own, under `name` sealed with the vault key
    /// as desktop seals it. Registering a vault already on the account is a
    /// success.
    ///
    /// `ApiError::PaymentRequired` when the account has no sync plan or no
    /// free vault slot; `ApiError::NoMasterKey` before the recovery phrase has
    /// unlocked this device. `vault_id` is the id the vault was opened under:
    /// 1 to 128 of `[A-Za-z0-9_-]`, a lowercase UUID in practice.
    pub async fn register_vault(&self, vault_id: String, name: String) -> Result<(), ApiError> {
        let master = self
            .master_key()
            .map_err(|error| ApiError::Storage {
                what: format!("secure store: {error}"),
            })?
            .map(Zeroizing::new)
            .ok_or(ApiError::NoMasterKey)?;
        billing::register_vault(&self.http(), &master, &vault_id, &name).await
    }

    /// Hands a StoreKit 2 transaction (`jwsRepresentation`) to the server,
    /// which verifies it with Apple, and returns the resulting billing status.
    pub async fn submit_app_store_transaction(
        &self,
        signed_transaction_info: String,
    ) -> Result<BillingStatus, ApiError> {
        billing::submit_app_store_transaction(&self.http(), &signed_transaction_info).await
    }

    /// A short-lived token for the web checkout (`POST /auth/checkout-token`).
    pub async fn checkout_token(&self) -> Result<CheckoutToken, ApiError> {
        billing::checkout_token(&self.http()).await
    }

    /// The web billing portal's URL. `ApiError::BillingPortalUnavailable` when
    /// the account has no web billing customer.
    pub async fn billing_portal_url(&self) -> Result<String, ApiError> {
        billing::billing_portal_url(&self.http()).await
    }

    /// Re-reads the entitlement (`POST /auth/billing/reconcile`), for after a
    /// purchase or a return from the web checkout.
    pub async fn refresh_billing(&self) -> Result<BillingStatus, ApiError> {
        billing::refresh_billing(&self.http()).await
    }
}

/// Desktop's billing calls. Rust-only, so the UniFFI surface iOS binds is
/// unchanged: [`BillingSnapshot`] keeps an unlimited vault count that the
/// flat [`BillingStatus`] record cannot.
impl AuthSession {
    /// `GET /auth/billing`.
    pub async fn billing_snapshot(&self) -> Result<BillingSnapshot, ApiError> {
        billing::billing_snapshot(&self.http()).await
    }

    /// `POST /auth/billing/reconcile`, naming the web checkout's transaction
    /// when the `memry://billing/complete` link carried one.
    pub async fn reconcile_billing(
        &self,
        transaction_id: Option<String>,
    ) -> Result<BillingSnapshot, ApiError> {
        billing::reconcile(&self.http(), transaction_id.as_deref()).await
    }

    /// What switching the subscription to `target` would charge.
    pub async fn preview_plan_change(
        &self,
        target: PlanChangeTarget,
    ) -> Result<PlanChangePreview, ApiError> {
        billing::preview_plan_change(&self.http(), target).await
    }

    /// Switches the subscription to `target`; answers with the new status.
    pub async fn change_plan(&self, target: PlanChangeTarget) -> Result<BillingSnapshot, ApiError> {
        billing::change_plan(&self.http(), target).await
    }
}

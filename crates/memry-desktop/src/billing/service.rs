//! Billing for the signed-in account, ported from Electron's `billing/paddle-billing.ts`: status,
//! the web checkout, the billing portal, plan changes, the reconcile after a `memry://billing`
//! link, and the plan verdict the open vault's sync gate starts on.
//!
//! Every status the server answers is cached (`sync.entitlement`) and told to the open vault's
//! gate, which hands a paid verdict to the driver's policy tier (`SyncDriver::set_entitled`).

use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use memry_core::api::errors::ApiError;
use memry_core::protocol::billing::BillingSnapshot;

use super::dto::{
    BillingActionResult, BillingStatusResult, CheckoutResult, PlanChangePreviewResult,
    PlanChangeTarget, PortalFailureReason, PortalResult, StartCheckoutInput,
};
use super::entitlement::{CachedEntitlement, EntitlementCache, is_paid};
use crate::account::AccountService;
use crate::error::CoreError;
use crate::launch_env::LaunchEnv;
use crate::registry::config::AppConfig;
use crate::session::{Session, lock};
use crate::sync::gate::{Entitlement, SyncStartGate};
use crate::telemetry::Service;
use crate::telemetry::diagnostics::Failure;
use crate::telemetry::main_warning::Level;

/// The account-area plan picker; it takes the checkout token in the fragment, so the user lands
/// signed in without a web login.
pub const DEFAULT_CHECKOUT_PAGE_URL: &str = "https://memrynote.com/account/sync";
/// Replaces [`DEFAULT_CHECKOUT_PAGE_URL`] when set to an `https:` URL.
pub const CHECKOUT_PAGE_URL_ENV: &str = "CHECKOUT_PAGE_URL";
/// Reconcile attempts after a `memry://billing/complete` link, [`RECONCILE_SPACING`] apart: the
/// payment webhook may land a few seconds after the browser returns.
pub const RECONCILE_ATTEMPTS: u32 = 5;
pub const RECONCILE_SPACING: Duration = Duration::from_secs(2);

/// Opens a URL in the system browser (`tauri-plugin-opener` in the app).
pub trait UrlOpener: Send + Sync {
    fn open(&self, url: &str) -> Result<(), String>;
}

/// The checkout page: `CHECKOUT_PAGE_URL` when it is a non-empty `https:` URL, else the default.
pub fn checkout_page_url(env: &LaunchEnv) -> String {
    match env.get(CHECKOUT_PAGE_URL_ENV).map(str::trim) {
        None | Some("") => DEFAULT_CHECKOUT_PAGE_URL.to_owned(),
        Some(page) if is_https(page) => page.to_owned(),
        Some(_) => {
            tracing::warn!(
                scope = "Billing",
                "{CHECKOUT_PAGE_URL_ENV} is not an https URL; the default checkout page is used"
            );
            DEFAULT_CHECKOUT_PAGE_URL.to_owned()
        }
    }
}

fn is_https(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|url| url.scheme() == "https")
}

/// `buildCheckoutPageUrl`: `plan` and `cadence` in the query when preselected, `token=` in the
/// fragment, both form-encoded as `URLSearchParams` writes them.
fn build_checkout_url(page: &str, token: &str, preselect: Option<StartCheckoutInput>) -> String {
    let mut url = url::Url::parse(page).expect("the checkout page is a parsed https URL");
    if let Some(input) = preselect {
        let kept: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| key != "plan" && key != "cadence")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        url.query_pairs_mut()
            .clear()
            .extend_pairs(kept)
            .append_pair("plan", input.plan.as_str())
            .append_pair("cadence", input.cadence.as_str());
    }
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", token)
        .finish();
    url.set_fragment(Some(&fragment));
    url.into()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn failure(error: &ApiError) -> Failure {
    Failure::new(Some(error.kind_and_code().1), error.to_string())
}

fn verdict(cached: Option<&CachedEntitlement>) -> Entitlement {
    match cached {
        Some(cached) if cached.is_paid => Entitlement::Entitled,
        Some(_) => Entitlement::Unentitled,
        None => Entitlement::Unknown,
    }
}

pub struct BillingService {
    account: Arc<AccountService>,
    cache: EntitlementCache,
    opener: Arc<dyn UrlOpener>,
    session: Session,
    telemetry: Option<Arc<Service>>,
    runtime: tokio::runtime::Handle,
    checkout_page: String,
    /// The open vault's sync gate; dangling when no supervisor runs.
    gate: Mutex<Weak<SyncStartGate>>,
}

impl BillingService {
    pub fn new(
        account: Arc<AccountService>,
        config: Arc<AppConfig>,
        opener: Arc<dyn UrlOpener>,
        session: Session,
        telemetry: Option<Arc<Service>>,
        runtime: tokio::runtime::Handle,
        env: &LaunchEnv,
    ) -> Self {
        Self {
            account,
            cache: EntitlementCache::new(config),
            opener,
            session,
            telemetry,
            runtime,
            checkout_page: checkout_page_url(env),
            gate: Mutex::new(Weak::new()),
        }
    }

    pub fn cache(&self) -> &EntitlementCache {
        &self.cache
    }

    /// `getValidAccessToken() == null`: signed out, or no token could be read.
    async fn signed_out(&self) -> bool {
        self.account.access_token_if_signed_in().await.is_none()
    }

    /// Caches the server's answer and tells the open vault's gate.
    fn remember(&self, snapshot: &BillingSnapshot) -> bool {
        let now = now_ms();
        let paid = is_paid(snapshot, now.div_euclid(1000));
        if let Err(error) = self.cache.set_from_snapshot(snapshot, now) {
            tracing::warn!(scope = "Billing", "could not cache the plan verdict: {error}");
        }
        if let Some(gate) = lock(&self.gate).upgrade() {
            gate.set_entitlement(if paid {
                Entitlement::Entitled
            } else {
                Entitlement::Unentitled
            });
        }
        paid
    }

    fn status_answer(&self, snapshot: BillingSnapshot) -> BillingStatusResult {
        self.remember(&snapshot);
        BillingStatusResult::Status(snapshot.into())
    }

    /// `GET /auth/billing` (`getBillingStatus`).
    pub async fn status(&self) -> Result<BillingStatusResult, ApiError> {
        if self.signed_out().await {
            return Ok(signed_out("Sign in to view billing"));
        }
        let snapshot = self.account.session().billing_snapshot().await?;
        Ok(self.status_answer(snapshot))
    }

    /// `POST /auth/billing/reconcile` (`refreshBillingStatus`), naming the checkout's
    /// transaction when the return link carried one.
    pub async fn refresh(
        &self,
        transaction_id: Option<String>,
    ) -> Result<BillingStatusResult, ApiError> {
        if self.signed_out().await {
            return Ok(signed_out("Sign in to refresh billing"));
        }
        let snapshot = self
            .account
            .session()
            .reconcile_billing(transaction_id)
            .await?;
        Ok(self.status_answer(snapshot))
    }

    /// `startBillingCheckout`: a checkout token, then the checkout page in the browser.
    pub async fn start_checkout(
        &self,
        preselect: Option<StartCheckoutInput>,
    ) -> Result<CheckoutResult, ApiError> {
        if self.signed_out().await {
            return Ok(CheckoutResult {
                success: false,
                error: Some("Sign in to start checkout".into()),
                checkout_url: None,
            });
        }
        let token = self.account.session().checkout_token().await?;
        let url = build_checkout_url(&self.checkout_page, &token.token, preselect);
        if let Err(error) = self.opener.open(&url) {
            // The URL carries the token: only the fact is logged.
            tracing::warn!(scope = "Billing", "could not open the checkout page: {error}");
            return Ok(CheckoutResult {
                success: false,
                error: Some("The browser could not be opened".into()),
                checkout_url: None,
            });
        }
        Ok(CheckoutResult {
            success: true,
            error: None,
            checkout_url: Some(url),
        })
    }

    /// `openBillingPortal`: a `409` is `no-billing-customer`, another refusal a plain failure.
    pub async fn open_portal(&self) -> Result<PortalResult, ApiError> {
        let failed = |reason, error| PortalResult {
            success: false,
            reason,
            portal_url: None,
            error,
        };
        if self.signed_out().await {
            return Ok(failed(None, Some("Sign in to manage billing".into())));
        }
        let url = match self.account.session().billing_portal_url().await {
            Ok(url) => url,
            Err(ApiError::BillingPortalUnavailable { .. }) => {
                tracing::warn!(scope = "Billing", "no billing customer for the portal");
                return Ok(failed(Some(PortalFailureReason::NoBillingCustomer), None));
            }
            Err(
                error @ (ApiError::Status { .. }
                | ApiError::RateLimited { .. }
                | ApiError::PaymentRequired { .. }
                | ApiError::WritesDisabled { .. }),
            ) => {
                tracing::warn!(scope = "Billing", "billing portal session failed: {error}");
                return Ok(failed(None, None));
            }
            Err(error) => return Err(error),
        };
        if let Err(error) = self.opener.open(&url) {
            tracing::warn!(scope = "Billing", "could not open the billing portal: {error}");
            return Ok(failed(None, Some("The browser could not be opened".into())));
        }
        Ok(PortalResult {
            success: true,
            reason: None,
            portal_url: Some(url),
            error: None,
        })
    }

    pub async fn preview_plan_change(
        &self,
        target: PlanChangeTarget,
    ) -> Result<PlanChangePreviewResult, ApiError> {
        if self.signed_out().await {
            return Ok(PlanChangePreviewResult::Failed(
                BillingActionResult::signed_out("Sign in to change your plan"),
            ));
        }
        let preview = self
            .account
            .session()
            .preview_plan_change(target.into())
            .await?;
        Ok(PlanChangePreviewResult::Preview(preview.into()))
    }

    /// Switches the subscription; Paddle prorates an upgrade today and a downgrade at renewal.
    pub async fn change_plan(
        &self,
        target: PlanChangeTarget,
    ) -> Result<BillingStatusResult, ApiError> {
        if self.signed_out().await {
            return Ok(signed_out("Sign in to change your plan"));
        }
        let snapshot = self.account.session().change_plan(target.into()).await?;
        Ok(self.status_answer(snapshot))
    }

    /// `reconcileBillingAndSync`, run for `memry://billing/complete`: up to
    /// [`RECONCILE_ATTEMPTS`] reconciles until the account reads paid. With no vault open the
    /// cached verdict is the result (opening one starts sync); otherwise the paid verdict
    /// reached the gate, which starts sync, and a pass runs. A failure is logged and counted,
    /// never a sign-out.
    pub async fn reconcile_and_start(&self, transaction_id: Option<String>) {
        for attempt in 0..RECONCILE_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(RECONCILE_SPACING).await;
            }
            let snapshot = if self.signed_out().await {
                None
            } else {
                match self
                    .account
                    .session()
                    .reconcile_billing(transaction_id.clone())
                    .await
                {
                    Ok(snapshot) => Some(snapshot),
                    Err(error) => {
                        tracing::warn!(
                            scope = "Billing",
                            "failed to reconcile billing from the deep link: {error}"
                        );
                        if let Some(telemetry) = &self.telemetry {
                            telemetry.track_main_warning(
                                "billing",
                                "deep_link_reconcile",
                                &failure(&error),
                                Some(attempt),
                            );
                        }
                        return;
                    }
                }
            };
            if snapshot.is_some_and(|snapshot| self.remember(&snapshot)) {
                if self.session.current().is_some()
                    && let Some(supervisor) = self.session.sync_supervisor()
                {
                    supervisor.foreground();
                }
                return;
            }
        }
        tracing::info!(
            scope = "Billing",
            "the account did not read paid after {RECONCILE_ATTEMPTS} reconciles"
        );
    }

    /// `resolveEntitlementForSyncStart`: a fresh unpaid verdict without a request, else the
    /// server's. Signed out or unreachable, the cached verdict holds for this launch, and with
    /// none the gate starts (the server answers `402` to an unpaid account).
    pub async fn resolve_for_sync_start(&self) -> Entitlement {
        let cached = self.cache.get();
        if cached
            .as_ref()
            .is_some_and(|cached| cached.is_unpaid_fresh(now_ms()))
        {
            return Entitlement::Unentitled;
        }
        if self.signed_out().await {
            tracing::warn!(
                scope = "Billing",
                "billing status unavailable; the cached plan holds for this launch"
            );
            if let Some(telemetry) = &self.telemetry {
                telemetry.track_main_log(
                    Level::Warn,
                    "Billing",
                    "entitlement_unavailable_treated_unpaid",
                    None,
                    None,
                    None,
                );
            }
            return verdict(cached.as_ref());
        }
        match self.account.session().billing_snapshot().await {
            Ok(snapshot) => {
                if self.remember(&snapshot) {
                    Entitlement::Entitled
                } else {
                    Entitlement::Unentitled
                }
            }
            Err(error) => {
                tracing::warn!(
                    scope = "Billing",
                    "billing status fetch failed; the cached plan holds for this launch: {error}"
                );
                if let Some(telemetry) = &self.telemetry {
                    telemetry.track_main_error("billing", "entitlement_resolve", &failure(&error));
                }
                verdict(cached.as_ref())
            }
        }
    }

    /// A new vault supervisor's gate: the cached verdict at once, then the resolved one. Every
    /// later answer goes to this gate until the next one replaces it.
    pub fn attach_gate(self: &Arc<Self>, gate: &Arc<SyncStartGate>) {
        *lock(&self.gate) = Arc::downgrade(gate);
        gate.set_entitlement(verdict(self.cache.get().as_ref()));
        let service = Arc::clone(self);
        let gate = Arc::downgrade(gate);
        self.runtime.spawn(async move {
            let resolved = service.resolve_for_sync_start().await;
            if let Some(gate) = gate.upgrade() {
                gate.set_entitlement(resolved);
            }
        });
    }

    /// The upload preflight's limit; `None` fails open.
    pub fn max_file_size(&self) -> Option<i64> {
        self.cache.max_file_size(now_ms())
    }

    /// The server refused an upload on its own size limit: the cached limit is wrong.
    pub fn invalidate_file_limit(&self) {
        if let Err(error) = self.cache.invalidate_limits() {
            tracing::warn!(scope = "Billing", "could not drop the cached file limit: {error}");
        }
    }
}

fn signed_out(error: &str) -> BillingStatusResult {
    BillingStatusResult::Failed(BillingActionResult::signed_out(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::billing::dto::{CheckoutCadence, CheckoutPlan};

    fn env(value: Option<&str>) -> LaunchEnv {
        let mut env = LaunchEnv::default();
        if let Some(value) = value {
            env.set(CHECKOUT_PAGE_URL_ENV, value);
        }
        env
    }

    #[test]
    fn the_checkout_page_is_the_default_unless_an_https_override_is_set() {
        assert_eq!(checkout_page_url(&env(None)), DEFAULT_CHECKOUT_PAGE_URL);
        assert_eq!(checkout_page_url(&env(Some("  "))), DEFAULT_CHECKOUT_PAGE_URL);
        assert_eq!(
            checkout_page_url(&env(Some(" https://staging.memrynote.com/account/sync "))),
            "https://staging.memrynote.com/account/sync"
        );
        for refused in ["http://memrynote.com/account/sync", "javascript:alert(1)", "nope"] {
            assert_eq!(
                checkout_page_url(&env(Some(refused))),
                DEFAULT_CHECKOUT_PAGE_URL,
                "{refused}"
            );
        }
    }

    /// `paddle-billing.portal.test.ts`: "opens the checkout page with the token in the hash".
    #[test]
    fn opens_the_checkout_page_with_the_token_in_the_hash() {
        assert_eq!(
            build_checkout_url(DEFAULT_CHECKOUT_PAGE_URL, "abc.def", None),
            "https://memrynote.com/account/sync#token=abc.def"
        );
        assert_eq!(
            build_checkout_url(DEFAULT_CHECKOUT_PAGE_URL, "a+b/c=d &e", None),
            "https://memrynote.com/account/sync#token=a%2Bb%2Fc%3Dd+%26e",
            "the fragment is form-encoded"
        );
    }

    /// "preselects the plan picked during onboarding".
    #[test]
    fn preselects_the_plan_picked_during_onboarding() {
        let preselect = StartCheckoutInput {
            plan: CheckoutPlan::Pro,
            cadence: CheckoutCadence::Annual,
        };
        assert_eq!(
            build_checkout_url(DEFAULT_CHECKOUT_PAGE_URL, "t", Some(preselect)),
            "https://memrynote.com/account/sync?plan=pro&cadence=annual#token=t"
        );
        assert_eq!(
            build_checkout_url(
                "https://example.test/sync?ref=app&plan=plus",
                "t",
                Some(preselect)
            ),
            "https://example.test/sync?ref=app&plan=pro&cadence=annual#token=t",
            "set, not appended twice"
        );
    }
}

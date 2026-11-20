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
    fn open(&self, url: &str) -> Result<(), OpenFailed>;
}

/// Why the browser did not open, without the URL: the opener's own error names its command line,
/// and a checkout URL carries its token, a portal URL its Paddle session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenFailed {
    /// The app does not open this URL's scheme.
    Refused,
    /// The OS could not launch a browser.
    Failed,
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

/// The checkout page's UTM tags (`marketing/utm.md`), so PostHog credits the visit to the app.
const CHECKOUT_UTM: [(&str, &str); 3] = [
    ("utm_source", "app"),
    ("utm_medium", "desktop"),
    ("utm_campaign", "checkout"),
];

/// `buildCheckoutPageUrl`: `plan` and `cadence` in the query when preselected, then the UTM tags,
/// and `token=` in the fragment, all form-encoded as `URLSearchParams` writes them.
fn build_checkout_url(page: &str, token: &str, preselect: Option<StartCheckoutInput>) -> String {
    let mut url = url::Url::parse(page).expect("the checkout page is a parsed https URL");
    let set: Vec<(&str, &str)> = preselect
        .map(|input| {
            [
                ("plan", input.plan.as_str()),
                ("cadence", input.cadence.as_str()),
            ]
        })
        .into_iter()
        .flatten()
        .chain(CHECKOUT_UTM)
        .collect();
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| set.iter().all(|(name, _)| key != name))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(kept)
        .extend_pairs(set);
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

/// Orders the server's answers: each request takes a number before it is sent, and only an
/// answer newer than the last one applied reaches the cache and the gate.
#[derive(Default)]
struct Asked {
    issued: u64,
    applied: u64,
}

pub struct BillingService {
    account: Arc<AccountService>,
    asked: Mutex<Asked>,
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
            asked: Mutex::default(),
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

    /// The number of a request about to be sent, for [`Self::remember`].
    fn ask(&self) -> u64 {
        let mut asked = lock(&self.asked);
        asked.issued += 1;
        asked.issued
    }

    /// Caches the answer to request `asked` and tells the open vault's gate whether it is paid.
    /// `None` when a newer answer was applied first, or the account signed out since: the
    /// answer is dropped.
    fn remember(&self, asked: u64, snapshot: &BillingSnapshot) -> Option<bool> {
        let mut order = lock(&self.asked);
        if asked <= order.applied {
            tracing::debug!(
                scope = "Billing",
                "dropped a billing answer older than the last one"
            );
            return None;
        }
        order.applied = asked;
        let now = now_ms();
        let paid = is_paid(snapshot, now.div_euclid(1000));
        if let Err(error) = self.cache.set_from_snapshot(snapshot, now) {
            tracing::warn!(
                scope = "Billing",
                "could not cache the plan verdict: {error}"
            );
        }
        if let Some(gate) = lock(&self.gate).upgrade() {
            gate.set_entitlement(if paid {
                Entitlement::Entitled
            } else {
                Entitlement::Unentitled
            });
        }
        Some(paid)
    }

    /// Sign-out: every answer still in flight is the account's that left, so none is applied,
    /// and the verdict goes. Cleared here too because an answer may have landed after the
    /// teardown emptied `sync`.
    pub fn forget(&self) {
        let mut order = lock(&self.asked);
        order.applied = order.issued;
        if let Err(error) = self.cache.clear() {
            tracing::warn!(
                scope = "Billing",
                "could not drop the plan verdict: {error}"
            );
        }
    }

    fn status_answer(&self, asked: u64, snapshot: BillingSnapshot) -> BillingStatusResult {
        self.remember(asked, &snapshot);
        BillingStatusResult::Status(snapshot.into())
    }

    /// `GET /auth/billing` (`getBillingStatus`).
    pub async fn status(&self) -> Result<BillingStatusResult, ApiError> {
        if self.signed_out().await {
            return Ok(signed_out("Sign in to view billing"));
        }
        let asked = self.ask();
        let snapshot = self.account.session().billing_snapshot().await?;
        Ok(self.status_answer(asked, snapshot))
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
        let asked = self.ask();
        let snapshot = self
            .account
            .session()
            .reconcile_billing(transaction_id)
            .await?;
        Ok(self.status_answer(asked, snapshot))
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
            tracing::warn!(
                scope = "Billing",
                "could not open the checkout page: {error:?}"
            );
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
            tracing::warn!(
                scope = "Billing",
                "could not open the billing portal: {error:?}"
            );
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
        let asked = self.ask();
        let snapshot = self.account.session().change_plan(target.into()).await?;
        Ok(self.status_answer(asked, snapshot))
    }

    /// `reconcileBillingAndSync`, run for `memry://billing/complete`: up to
    /// [`RECONCILE_ATTEMPTS`] reconciles until the account reads paid. With no vault open the
    /// cached verdict is the result (opening one starts sync); otherwise the paid verdict
    /// reached the gate, which starts sync, and a pass runs. The server's `409 Transaction is
    /// not completed yet` is not paid yet (Electron's loop ended on it, `paddle-billing.ts:155-177`);
    /// any other failure ends the loop. A failure is logged and counted, never a sign-out.
    pub async fn reconcile_and_start(&self, transaction_id: Option<String>) {
        let mut not_completed = None;
        for attempt in 0..RECONCILE_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(RECONCILE_SPACING).await;
            }
            if self.signed_out().await {
                continue;
            }
            let asked = self.ask();
            match self
                .account
                .session()
                .reconcile_billing(transaction_id.clone())
                .await
            {
                Ok(snapshot) => {
                    not_completed = None;
                    if self.remember(asked, &snapshot) == Some(true) {
                        if self.session.current().is_some()
                            && let Some(supervisor) = self.session.sync_supervisor()
                        {
                            supervisor.foreground();
                        }
                        return;
                    }
                }
                Err(error @ ApiError::Status { status: 409, .. }) => not_completed = Some(error),
                Err(error) => return self.reconcile_failed(&error),
            }
        }
        if let Some(error) = not_completed {
            return self.reconcile_failed(&error);
        }
        tracing::info!(
            scope = "Billing",
            "the account did not read paid after {RECONCILE_ATTEMPTS} reconciles"
        );
    }

    fn reconcile_failed(&self, error: &ApiError) {
        tracing::warn!(
            scope = "Billing",
            "failed to reconcile billing from the deep link: {error}"
        );
        if let Some(telemetry) = &self.telemetry {
            telemetry.track_main_error("billing", "deep_link_reconcile", &failure(error));
        }
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
        let asked = self.ask();
        match self.account.session().billing_snapshot().await {
            Ok(snapshot) => match self.remember(asked, &snapshot) {
                Some(true) => Entitlement::Entitled,
                Some(false) => Entitlement::Unentitled,
                // A newer answer was applied while this one was in flight.
                None => verdict(self.cache.get().as_ref()),
            },
            Err(error) => {
                tracing::warn!(
                    scope = "Billing",
                    "billing status fetch failed; the cached plan holds for this launch: {error}"
                );
                if let Some(telemetry) = &self.telemetry {
                    telemetry.track_main_error("billing", "entitlement_resolve", &failure(&error));
                }
                // A newer answer may have landed while this request failed.
                verdict(self.cache.get().as_ref())
            }
        }
    }

    /// A new vault supervisor's gate: the cached verdict at once, then the server's, which
    /// [`Self::remember`] tells it in order with every later answer until the next gate
    /// replaces it.
    pub fn attach_gate(self: &Arc<Self>, gate: &Arc<SyncStartGate>) {
        *lock(&self.gate) = Arc::downgrade(gate);
        gate.set_entitlement(verdict(self.cache.get().as_ref()));
        let service = Arc::clone(self);
        self.runtime.spawn(async move {
            service.resolve_for_sync_start().await;
        });
    }

    /// The upload preflight's limit; `None` fails open.
    pub fn max_file_size(&self) -> Option<i64> {
        self.cache.max_file_size(now_ms())
    }

    /// The server refused an upload on its own size limit: the cached limit is wrong.
    pub fn invalidate_file_limit(&self) {
        if let Err(error) = self.cache.invalidate_limits() {
            tracing::warn!(
                scope = "Billing",
                "could not drop the cached file limit: {error}"
            );
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
        assert_eq!(
            checkout_page_url(&env(Some("  "))),
            DEFAULT_CHECKOUT_PAGE_URL
        );
        assert_eq!(
            checkout_page_url(&env(Some(" https://staging.memrynote.com/account/sync "))),
            "https://staging.memrynote.com/account/sync"
        );
        for refused in [
            "http://memrynote.com/account/sync",
            "javascript:alert(1)",
            "nope",
        ] {
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
            "https://memrynote.com/account/sync?utm_source=app&utm_medium=desktop&utm_campaign=checkout#token=abc.def"
        );
        assert_eq!(
            build_checkout_url(DEFAULT_CHECKOUT_PAGE_URL, "a+b/c=d &e", None),
            "https://memrynote.com/account/sync?utm_source=app&utm_medium=desktop&utm_campaign=checkout#token=a%2Bb%2Fc%3Dd+%26e",
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
            "https://memrynote.com/account/sync?plan=pro&cadence=annual&utm_source=app&utm_medium=desktop&utm_campaign=checkout#token=t"
        );
        assert_eq!(
            build_checkout_url(
                "https://example.test/sync?ref=app&plan=plus&utm_source=x",
                "t",
                Some(preselect)
            ),
            "https://example.test/sync?ref=app&plan=pro&cadence=annual&utm_source=app&utm_medium=desktop&utm_campaign=checkout#token=t",
            "set, not appended twice"
        );
    }
}

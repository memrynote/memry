//! `BillingService` (Step 20b) over the scripted server of `account_service`, a real
//! `memry-config.json` and a real sync gate. Ports `paddle-billing.activation.test.ts` and
//! `paddle-billing.portal.test.ts`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::account::{AccountService, device};
use memry_desktop::billing::dto::{
    BillingStatusResult, CheckoutCadence, CheckoutPlan, PlanChangePeriod, PlanChangePlan,
    PlanChangePreviewResult, PlanChangeTarget, PortalFailureReason, StartCheckoutInput,
};
use memry_desktop::billing::service::{RECONCILE_ATTEMPTS, RECONCILE_SPACING};
use memry_desktop::billing::{BillingService, OpenFailed, UrlOpener};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::registry::VaultRegistry;
use memry_desktop::registry::config::AppConfig;
use memry_desktop::session::Session;
use memry_desktop::sync::gate::{Entitlement, SyncStartGate};
use serde_json::{Value, json};

use crate::account_service::{Keychain, MASTER, Script, access_token};

const RECONCILE: &str = "/auth/billing/reconcile";
const STATUS: &str = "/auth/billing";

#[derive(Default)]
struct Browser {
    opened: Mutex<Vec<String>>,
    fail: bool,
}

impl UrlOpener for Browser {
    fn open(&self, url: &str) -> Result<(), OpenFailed> {
        if self.fail {
            return Err(OpenFailed::Failed);
        }
        self.opened.lock().unwrap().push(url.to_owned());
        Ok(())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    script: Arc<Script>,
    config: Arc<AppConfig>,
    browser: Arc<Browser>,
    account: Arc<AccountService>,
    session: Session,
    billing: Arc<BillingService>,
}

fn fixture(signed_in: bool) -> Fixture {
    fixture_with(signed_in, Browser::default())
}

fn fixture_with(signed_in: bool, browser: Browser) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
    let keychain = Arc::new(Keychain::holding_keys(Some(MASTER)));
    if signed_in {
        keychain
            .set(
                SecureStoreKey::AccessToken,
                access_token("server-device").into_bytes(),
            )
            .unwrap();
        keychain
            .set(SecureStoreKey::RefreshToken, b"refresh".to_vec())
            .unwrap();
    }
    let script = Arc::new(Script::default());
    let account = Arc::new(
        AccountService::new(
            script.clone(),
            keychain,
            "https://sync.test".into(),
            device::descriptor("1.0.0"),
            config.clone(),
        )
        .unwrap(),
    );
    let browser = Arc::new(browser);
    let session = Session::new(VaultRegistry::new(config.clone()));
    let billing = Arc::new(BillingService::new(
        account.clone(),
        config.clone(),
        browser.clone(),
        session.clone(),
        None,
        tokio::runtime::Handle::current(),
        &LaunchEnv::default(),
    ));
    Fixture {
        _dir: dir,
        script,
        config,
        browser,
        account,
        session,
        billing,
    }
}

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

fn status(plan: &str, status: &str) -> Value {
    json!({
        "plan": plan, "cadence": "monthly", "status": status, "source": "paddle",
        "email": "a@b.c",
        "limits": {
            "storageLimit": 1_073_741_824, "maxFileSize": 5_242_880, "maxVaults": 1,
            "versionHistoryDays": 30,
        },
        "usage": { "storageUsed": 0 },
        "expiresAt": null,
        "canManageBilling": true,
    })
}

impl Fixture {
    fn entitlement(&self) -> Value {
        self.config
            .read(|c| c.get("sync").and_then(|s| s.get("entitlement")).cloned())
            .unwrap_or(Value::Null)
    }

    fn cache(&self, entitlement: Value) {
        self.config
            .update(|c| {
                c.insert("sync".into(), json!({ "entitlement": entitlement }));
                Ok::<_, memry_desktop::registry::config::ConfigError>(())
            })
            .unwrap();
    }

    fn billing_requests(&self) -> Vec<(String, String, Value)> {
        self.script
            .requests()
            .into_iter()
            .filter(|(_, path, _)| path.starts_with("/auth/"))
            .collect()
    }
}

/// Lets spawned work and its scripted requests run on the paused clock.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn signed_out_calls_answer_electrons_envelopes_without_a_request() {
    let f = fixture(false);
    let BillingStatusResult::Failed(failed) = f.billing.status().await.unwrap() else {
        panic!("signed out");
    };
    assert_eq!(failed.error.as_deref(), Some("Sign in to view billing"));
    let checkout = f.billing.start_checkout(None).await.unwrap();
    assert!(!checkout.success);
    assert_eq!(checkout.error.as_deref(), Some("Sign in to start checkout"));
    let portal = f.billing.open_portal().await.unwrap();
    assert_eq!(portal.error.as_deref(), Some("Sign in to manage billing"));
    let target = PlanChangeTarget {
        plan: PlanChangePlan::Plus,
        cadence: PlanChangePeriod::Annual,
    };
    assert!(matches!(
        f.billing.preview_plan_change(target).await.unwrap(),
        PlanChangePreviewResult::Failed(_)
    ));
    assert!(f.billing_requests().is_empty());
    assert!(f.browser.opened.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_status_is_cached_and_reaches_the_open_vaults_gate() {
    let f = fixture(true);
    let gate = Arc::new(SyncStartGate::default());
    f.cache(json!({ "isPaid": false, "plan": "free", "status": "inactive", "cachedAt": now_ms() }));
    f.billing.attach_gate(&gate);
    assert_eq!(
        gate.entitlement(),
        Entitlement::Unentitled,
        "the cached verdict at once"
    );
    settle().await;
    assert!(
        f.billing_requests().is_empty(),
        "a fresh unpaid verdict asks nothing"
    );

    f.script.answer(200, status("plus", "active"));
    let BillingStatusResult::Status(dto) = f.billing.status().await.unwrap() else {
        panic!("signed in");
    };
    assert_eq!(dto.plan, "plus");
    assert_eq!(dto.limits.max_vaults, Some(1));
    assert_eq!(gate.entitlement(), Entitlement::Entitled);
    let cached = f.entitlement();
    assert_eq!(cached["isPaid"], json!(true));
    assert_eq!(cached["limits"], json!({ "maxFileSize": 5_242_880 }));
    assert_eq!(f.billing.max_file_size(), Some(5_242_880));

    f.billing.invalidate_file_limit();
    assert_eq!(f.billing.max_file_size(), None);
    assert_eq!(f.entitlement()["isPaid"], json!(true));
}

#[tokio::test]
async fn a_refresh_names_the_transaction_and_a_plan_change_caches_its_answer() {
    let f = fixture(true);
    f.script.answer(200, status("plus", "active"));
    f.billing.refresh(Some("txn_1".into())).await.unwrap();
    f.script.answer(200, status("plus", "active"));
    f.billing.refresh(None).await.unwrap();
    f.script.answer(
        200,
        json!({
            "plan": "plus", "cadence": "annual", "isUpgrade": true, "effective": "immediate",
            "immediateChargeAmount": "4000", "recurringAmount": "4800", "currencyCode": "USD",
            "nextBilledAt": null,
        }),
    );
    let target = PlanChangeTarget {
        plan: PlanChangePlan::Plus,
        cadence: PlanChangePeriod::Annual,
    };
    let PlanChangePreviewResult::Preview(preview) =
        f.billing.preview_plan_change(target).await.unwrap()
    else {
        panic!("a preview");
    };
    assert_eq!(preview.immediate_charge_amount.as_deref(), Some("4000"));
    f.script.answer(200, status("free", "canceled"));
    f.billing.change_plan(target).await.unwrap();

    let body = json!({ "plan": "plus", "cadence": "annual" });
    assert_eq!(
        f.billing_requests(),
        vec![
            (
                "POST".into(),
                RECONCILE.into(),
                json!({ "transactionId": "txn_1" })
            ),
            ("POST".into(), RECONCILE.into(), json!({})),
            (
                "POST".into(),
                "/auth/billing/change-plan/preview".into(),
                body.clone()
            ),
            ("POST".into(), "/auth/billing/change-plan".into(), body),
        ]
    );
    assert_eq!(
        f.entitlement()["isPaid"],
        json!(false),
        "the last answer is cached"
    );
}

#[tokio::test]
async fn opens_the_checkout_page_with_the_token_in_the_hash() {
    let f = fixture(true);
    f.script
        .answer(200, json!({ "checkoutToken": "tok.sig", "expiresAt": 9 }));
    let result = f
        .billing
        .start_checkout(Some(StartCheckoutInput {
            plan: CheckoutPlan::Plus,
            cadence: CheckoutCadence::Monthly,
        }))
        .await
        .unwrap();
    let url = "https://memrynote.com/account/sync?plan=plus&cadence=monthly#token=tok.sig";
    assert!(result.success);
    assert_eq!(result.checkout_url.as_deref(), Some(url));
    assert_eq!(*f.browser.opened.lock().unwrap(), vec![url.to_owned()]);
    assert_eq!(f.billing_requests()[0].1, "/auth/checkout-token");
}

#[tokio::test]
async fn a_checkout_the_browser_cannot_open_fails_without_the_token() {
    let f = fixture_with(
        true,
        Browser {
            fail: true,
            ..Browser::default()
        },
    );
    f.script
        .answer(200, json!({ "checkoutToken": "tok.sig", "expiresAt": 9 }));
    let result = f.billing.start_checkout(None).await.unwrap();
    assert!(!result.success);
    assert_eq!(result.checkout_url, None);
}

#[tokio::test]
async fn opens_the_portal_url_from_the_server() {
    let f = fixture(true);
    f.script.answer(
        200,
        json!({ "portalUrl": "https://customer-portal.paddle.com/x" }),
    );
    let result = f.billing.open_portal().await.unwrap();
    assert!(result.success);
    assert_eq!(
        *f.browser.opened.lock().unwrap(),
        vec!["https://customer-portal.paddle.com/x".to_owned()]
    );
}

#[tokio::test]
async fn reports_a_missing_billing_customer_instead_of_throwing() {
    let f = fixture(true);
    f.script.answer(
        409,
        json!({ "error": { "code": "NO_BILLING_CUSTOMER", "message": "none" } }),
    );
    let result = f.billing.open_portal().await.unwrap();
    assert!(!result.success);
    assert_eq!(result.reason, Some(PortalFailureReason::NoBillingCustomer));
    assert!(f.browser.opened.lock().unwrap().is_empty());
}

#[tokio::test]
async fn returns_a_plain_failure_for_other_server_errors() {
    let f = fixture(true);
    f.script
        .answer(400, json!({ "error": { "code": "BAD", "message": "bad" } }));
    let result = f.billing.open_portal().await.unwrap();
    assert!(!result.success);
    assert_eq!((result.reason, result.error), (None, None));
}

#[tokio::test]
async fn resolve_entitlement_for_sync_start_returns_a_recent_cached_unpaid_without_a_server_call() {
    let f = fixture(true);
    f.cache(json!({ "isPaid": false, "plan": "free", "status": "inactive", "cachedAt": now_ms() - 60_000 }));
    assert_eq!(
        f.billing.resolve_for_sync_start().await,
        Entitlement::Unentitled
    );
    assert!(f.billing_requests().is_empty());
}

#[tokio::test]
async fn re_asks_the_server_when_the_cached_unpaid_verdict_is_stale_and_sees_the_upgrade() {
    for cached_at in [json!(now_ms() - 3_601_000), Value::Null] {
        let f = fixture(true);
        let mut cached = json!({ "isPaid": false, "plan": "free", "status": "inactive" });
        if !cached_at.is_null() {
            cached["cachedAt"] = cached_at;
        }
        f.cache(cached);
        f.script.answer(200, status("pro", "active"));
        assert_eq!(
            f.billing.resolve_for_sync_start().await,
            Entitlement::Entitled
        );
        assert_eq!(f.script.count(STATUS), 1);
        assert_eq!(f.entitlement()["isPaid"], json!(true));
    }
}

#[tokio::test]
async fn an_unreachable_server_keeps_the_cached_verdict_and_none_leaves_it_unknown() {
    let f = fixture(true);
    f.script
        .answer(400, json!({ "error": { "code": "BAD", "message": "bad" } }));
    assert_eq!(
        f.billing.resolve_for_sync_start().await,
        Entitlement::Unknown
    );

    f.cache(json!({ "isPaid": true, "plan": "plus", "status": "active" }));
    f.script
        .answer(400, json!({ "error": { "code": "BAD", "message": "bad" } }));
    assert_eq!(
        f.billing.resolve_for_sync_start().await,
        Entitlement::Entitled,
        "a paid verdict has no TTL"
    );

    let signed_out = fixture(false);
    signed_out.cache(json!({ "isPaid": false, "plan": "free", "status": "inactive" }));
    assert_eq!(
        signed_out.billing.resolve_for_sync_start().await,
        Entitlement::Unentitled
    );
    assert!(signed_out.billing_requests().is_empty());
}

/// `reconcileBillingAndSync`: five attempts two seconds apart while the account reads unpaid.
#[tokio::test(start_paused = true)]
async fn reconcile_billing_and_sync_tries_five_times_two_seconds_apart() {
    let f = fixture(true);
    for _ in 0..RECONCILE_ATTEMPTS {
        f.script.answer(200, status("free", "inactive"));
    }
    let billing = f.billing.clone();
    let run = tokio::spawn(async move { billing.reconcile_and_start(Some("txn_9".into())).await });
    settle().await;
    assert_eq!(f.script.count(RECONCILE), 1, "the first attempt at once");
    for attempt in 2..=RECONCILE_ATTEMPTS as usize {
        tokio::time::advance(RECONCILE_SPACING - Duration::from_millis(1)).await;
        settle().await;
        assert_eq!(f.script.count(RECONCILE), attempt - 1, "not before 2 s");
        tokio::time::advance(Duration::from_millis(1)).await;
        settle().await;
        assert_eq!(f.script.count(RECONCILE), attempt);
    }
    run.await.unwrap();
    assert_eq!(f.script.count(RECONCILE), RECONCILE_ATTEMPTS as usize);
    assert!(
        f.billing_requests()
            .iter()
            .all(|(_, _, body)| body == &json!({ "transactionId": "txn_9" }))
    );
}

/// "reconcileBillingAndSync caches but leaves the runtime to vault open on first run": the first
/// paid answer ends the loop, and its verdict is cached and told to the gate.
#[tokio::test(start_paused = true)]
async fn reconcile_billing_and_sync_stops_on_the_first_paid_answer() {
    let f = fixture(true);
    let gate = Arc::new(SyncStartGate::default());
    f.script.answer(200, status("free", "inactive"));
    f.billing.attach_gate(&gate);
    settle().await;
    assert_eq!(gate.entitlement(), Entitlement::Unentitled);

    f.script.answer(200, status("free", "inactive"));
    f.script.answer(200, status("plus", "active"));
    f.billing.reconcile_and_start(None).await;

    assert_eq!(f.script.count(RECONCILE), 2);
    assert_eq!(gate.entitlement(), Entitlement::Entitled);
    assert_eq!(f.entitlement()["isPaid"], json!(true));
}

#[tokio::test(start_paused = true)]
async fn a_reconcile_failure_ends_the_loop_and_keeps_the_session() {
    let f = fixture(true);
    f.script
        .answer(400, json!({ "error": { "code": "BAD", "message": "bad" } }));
    f.billing.reconcile_and_start(None).await;
    assert_eq!(f.script.count(RECONCILE), 1);
    f.script.answer(200, status("plus", "active"));
    assert!(matches!(
        f.billing.status().await.unwrap(),
        BillingStatusResult::Status(_)
    ));
}

/// The checkout URL carries a token valid for ten minutes and the portal URL a Paddle session:
/// a browser that cannot open them leaves neither in the log, whatever its error says.
#[test]
fn a_browser_that_cannot_open_logs_neither_the_token_nor_the_portal_url() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let f = runtime.block_on(async {
        fixture_with(
            true,
            Browser {
                fail: true,
                ..Browser::default()
            },
        )
    });
    f.script.answer(
        200,
        json!({ "checkoutToken": "tok.SECRET", "expiresAt": 9 }),
    );
    let portal = "https://customer-portal.paddle.com/session-SECRET";
    f.script.answer(200, json!({ "portalUrl": portal }));

    let ((checkout, opened), lines) =
        crate::on_warning::logged("memry_desktop::billing::service", || {
            runtime.block_on(async {
                (
                    f.billing.start_checkout(None).await.unwrap(),
                    f.billing.open_portal().await.unwrap(),
                )
            })
        });

    assert!(!checkout.success && !opened.success);
    assert_eq!(lines.len(), 2, "both failures are logged: {lines:?}");
    for line in &lines {
        assert!(
            !line.contains("token=") && !line.contains("SECRET") && !line.contains(portal),
            "{line}"
        );
    }
}

/// An unpaid status asked before the deep link's reconcile answers after it: the reconcile's
/// paid verdict stays, in the cache and at the gate.
#[tokio::test(start_paused = true)]
async fn an_older_answer_landing_late_does_not_overwrite_a_newer_one() {
    let f = fixture(true);
    let gate = Arc::new(SyncStartGate::default());
    let late = f.script.held_answer(200, status("free", "inactive"));
    f.script.answer(200, status("plus", "active"));
    f.billing.attach_gate(&gate);
    settle().await;
    assert_eq!(f.script.count(STATUS), 1, "the status is in flight");

    f.billing.reconcile_and_start(None).await;
    assert_eq!(gate.entitlement(), Entitlement::Entitled);
    late.notify_one();
    settle().await;

    assert_eq!(gate.entitlement(), Entitlement::Entitled);
    assert_eq!(f.entitlement()["isPaid"], json!(true));
}

/// Account A's status lands after A signed out: nothing of it is kept for the next account.
#[tokio::test]
async fn an_answer_landing_after_sign_out_is_not_kept() {
    let f = fixture(true);
    let late = f.script.held_answer(200, status("plus", "active"));
    let billing = f.billing.clone();
    let asked = tokio::spawn(async move { billing.status().await });
    settle().await;
    assert_eq!(f.script.count(STATUS), 1, "the status is in flight");

    f.script.answer(200, json!({}));
    f.account.sign_out(&f.session).await.unwrap();
    f.billing.forget();
    late.notify_one();
    asked.await.unwrap().unwrap();

    assert_eq!(f.entitlement(), Value::Null);
    assert_eq!(f.billing.max_file_size(), None);
}

/// The server answers `409 Transaction is not completed yet` until the payment webhook lands:
/// the loop waits it out.
#[tokio::test(start_paused = true)]
async fn a_transaction_not_completed_yet_is_retried() {
    let f = fixture(true);
    let gate = Arc::new(SyncStartGate::default());
    f.cache(json!({ "isPaid": false, "plan": "free", "status": "inactive", "cachedAt": now_ms() }));
    f.billing.attach_gate(&gate);
    settle().await;
    f.script.answer(
        409,
        json!({ "error": { "code": "CONFLICT", "message": "Transaction is not completed yet" } }),
    );
    f.script.answer(200, status("plus", "active"));

    let billing = f.billing.clone();
    let run = tokio::spawn(async move { billing.reconcile_and_start(Some("txn_1".into())).await });
    settle().await;
    assert_eq!(f.script.count(RECONCILE), 1);
    assert_eq!(gate.entitlement(), Entitlement::Unentitled);
    tokio::time::advance(RECONCILE_SPACING).await;
    run.await.unwrap();

    assert_eq!(f.script.count(RECONCILE), 2);
    assert_eq!(gate.entitlement(), Entitlement::Entitled);
}

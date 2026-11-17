//! Billing's place in the app: the service over the account and the session, the browser it
//! opens the checkout and the portal in, and the `memry://billing/start` and
//! `memry://billing/complete` handlers (`apps/desktop/src/main/index.ts:1229-1238`). The router
//! has already focused the window and opened Settings > Account.

use std::sync::Arc;

use memry_desktop::account::AccountService;
use memry_desktop::billing::{BillingService, OpenFailed, UrlOpener};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::registry::config::AppConfig;
use memry_desktop::session::Session;
use memry_desktop::shell::deep_link::DeepLink;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::ErrorKind;
use crate::deep_link::DeepLinkRouter;
use crate::shell::{external, services};

struct Browser(AppHandle<Wry>);

impl UrlOpener for Browser {
    /// The opener's message names the URL, which carries the checkout token: only its kind leaves.
    fn open(&self, url: &str) -> Result<(), OpenFailed> {
        external::open_url(&self.0, url).map_err(|error| match error.kind {
            ErrorKind::Invalid => OpenFailed::Refused,
            _ => OpenFailed::Failed,
        })
    }
}

/// Builds and manages the service, and registers its deep link handlers.
pub fn manage(
    app: &AppHandle<Wry>,
    runtime: tokio::runtime::Handle,
    account: Arc<AccountService>,
    session: Session,
) -> Arc<BillingService> {
    let billing = Arc::new(BillingService::new(
        account,
        app.state::<Arc<AppConfig>>().inner().clone(),
        Arc::new(Browser(app.clone())),
        session,
        services::telemetry(app),
        runtime,
        &app.state::<LaunchEnv>(),
    ));
    app.manage(billing.clone());
    let router = app.state::<DeepLinkRouter>();
    router.on("billing_start", Arc::new(start_checkout));
    router.on("billing_complete", Arc::new(reconcile));
    billing
}

fn service(app: &AppHandle<Wry>) -> Arc<BillingService> {
    app.state::<Arc<BillingService>>().inner().clone()
}

fn start_checkout(app: &AppHandle<Wry>, _link: &DeepLink) {
    let billing = service(app);
    tauri::async_runtime::spawn(async move {
        match billing.start_checkout(None).await {
            Ok(result) if !result.success => tracing::warn!(
                scope = "Billing",
                "the checkout link did not open the checkout: {}",
                result.error.unwrap_or_default()
            ),
            Ok(_) => {}
            Err(error) => tracing::warn!(
                scope = "Billing",
                "the checkout link could not start the checkout: {error}"
            ),
        }
    });
}

fn reconcile(app: &AppHandle<Wry>, link: &DeepLink) {
    let DeepLink::BillingComplete { transaction_id } = link else {
        return;
    };
    let billing = service(app);
    let transaction_id = transaction_id.clone();
    tauri::async_runtime::spawn(async move { billing.reconcile_and_start(transaction_id).await });
}

//! Plan, checkout, billing portal and plan changes (`apps/desktop/src/main/ipc/account-handlers.ts`
//! `account:*` billing channels). Each command calls one `BillingService` method; a server or
//! network failure rejects, as Electron's handlers throw.

use std::sync::Arc;

use memry_desktop::billing::BillingService;
use memry_desktop::billing::dto::{
    BillingStatusResult, CheckoutResult, PlanChangePreviewResult, PlanChangeTarget, PortalResult,
    RefreshBillingInput, StartCheckoutInput,
};
use memry_desktop::error::CoreError;
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind, log_failure};

/// The service exists from the `Schedulers` stage on.
fn billing(app: &AppHandle<Wry>, command: &str) -> Result<Arc<BillingService>, CommandError> {
    app.try_state::<Arc<BillingService>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| {
            let error = CommandError::new(
                ErrorKind::Internal,
                "billing_unavailable",
                "billing is not ready yet",
            );
            log_failure(command, &error);
            error
        })
}

fn failed(command: &str, error: &impl CoreError) -> CommandError {
    let mapped = CommandError::from_core(error);
    log_failure(command, &mapped);
    mapped
}

/// Opens the checkout page in the browser, with the plan picked during onboarding.
#[tauri::command]
#[specta::specta]
pub async fn account_start_checkout(
    app: AppHandle<Wry>,
    input: Option<StartCheckoutInput>,
) -> Result<CheckoutResult, CommandError> {
    const NAME: &str = "account_start_checkout";
    billing(&app, NAME)?
        .start_checkout(input)
        .await
        .map_err(|e| failed(NAME, &e))
}

#[tauri::command]
#[specta::specta]
pub async fn account_get_billing_status(
    app: AppHandle<Wry>,
) -> Result<BillingStatusResult, CommandError> {
    const NAME: &str = "account_get_billing_status";
    billing(&app, NAME)?
        .status()
        .await
        .map_err(|e| failed(NAME, &e))
}

/// Re-reads the plan from the payment provider (`POST /auth/billing/reconcile`).
#[tauri::command]
#[specta::specta]
pub async fn account_refresh_billing_status(
    app: AppHandle<Wry>,
    input: Option<RefreshBillingInput>,
) -> Result<BillingStatusResult, CommandError> {
    const NAME: &str = "account_refresh_billing_status";
    billing(&app, NAME)?
        .refresh(input.and_then(|input| input.transaction_id))
        .await
        .map_err(|e| failed(NAME, &e))
}

#[tauri::command]
#[specta::specta]
pub async fn account_open_billing_portal(
    app: AppHandle<Wry>,
) -> Result<PortalResult, CommandError> {
    const NAME: &str = "account_open_billing_portal";
    billing(&app, NAME)?
        .open_portal()
        .await
        .map_err(|e| failed(NAME, &e))
}

#[tauri::command]
#[specta::specta]
pub async fn account_preview_plan_change(
    app: AppHandle<Wry>,
    target: PlanChangeTarget,
) -> Result<PlanChangePreviewResult, CommandError> {
    const NAME: &str = "account_preview_plan_change";
    billing(&app, NAME)?
        .preview_plan_change(target)
        .await
        .map_err(|e| failed(NAME, &e))
}

#[tauri::command]
#[specta::specta]
pub async fn account_change_plan(
    app: AppHandle<Wry>,
    target: PlanChangeTarget,
) -> Result<BillingStatusResult, CommandError> {
    const NAME: &str = "account_change_plan";
    billing(&app, NAME)?
        .change_plan(target)
        .await
        .map_err(|e| failed(NAME, &e))
}

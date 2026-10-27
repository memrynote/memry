//! The steps this step owns: `flush-windows`, `close-vault` and `flush-telemetry`. Every other
//! step belongs to the owner of the thing it stops and registers in its own PR.

use std::sync::Arc;

use memry_desktop::session::Session;
use memry_desktop::shell::shutdown::{Deadline, ShutdownContext, StepFn, TELEMETRY_FLUSH};
use memry_desktop::telemetry::logship::LogShip;
use memry_desktop::telemetry::service::FlushReason;
use tauri::{AppHandle, Manager, Wry};

use super::ShutdownService;
use crate::commands::error::{CommandError, ErrorKind};
use crate::flush::FlushService;
use crate::windows::registry::WindowRegistry;

fn step(
    app: &AppHandle<Wry>,
    run: impl Fn(
        AppHandle<Wry>,
        ShutdownContext,
        Deadline,
    ) -> memry_desktop::shell::shutdown::StepFuture
    + Send
    + Sync
    + 'static,
) -> StepFn {
    let app = app.clone();
    Arc::new(move |ctx, deadline| run(app.clone(), ctx, deadline))
}

pub fn register(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let service = app.state::<ShutdownService>();
    let to_error = |error: memry_desktop::shell::shutdown::UnknownStep| {
        CommandError::new(ErrorKind::Internal, "shutdown_step", error.to_string())
    };
    service
        .register(
            "flush-windows",
            step(app, |app, _, deadline| {
                Box::pin(flush_windows(app, deadline))
            }),
        )
        .map_err(to_error)?;
    service
        .register(
            "close-vault",
            step(app, |app, _, _| Box::pin(close_vault(app))),
        )
        .map_err(to_error)?;
    service
        .register(
            "flush-telemetry",
            step(app, |app, _, deadline| {
                Box::pin(flush_telemetry(app, deadline))
            }),
        )
        .map_err(to_error)
}

/// Renderer edits still sitting in an editor reach main. Every window is asked at once.
async fn flush_windows(app: AppHandle<Wry>, deadline: Deadline) -> Result<(), String> {
    let labels: Vec<String> = WindowRegistry::app_windows(&app)
        .iter()
        .map(|window| window.label().to_owned())
        .collect();
    let asks: Vec<_> = labels
        .into_iter()
        .map(|label| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                app.state::<FlushService>()
                    .request(&app, &label, deadline)
                    .await
            })
        })
        .collect();
    for ask in asks {
        // A window that did not answer is logged by the request; the quit goes on.
        let _answered = ask.await;
    }
    Ok(())
}

async fn close_vault(app: AppHandle<Wry>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Session>().close())
        .await
        .map_err(|error| error.to_string())
}

/// Last, and bounded: both queues are mirrored to disk and drain on the next launch, so a flush
/// cut short delays events instead of losing them.
async fn flush_telemetry(app: AppHandle<Wry>, deadline: Deadline) -> Result<(), String> {
    let Some(service) = crate::shell::services::telemetry(&app) else {
        return Ok(());
    };
    let ship = app.try_state::<Arc<LogShip>>().map(|s| s.inner().clone());
    let flush = async {
        service.flush(FlushReason::Shutdown).await;
        if let Some(ship) = ship {
            ship.flush().await;
        }
    };
    if tokio::time::timeout(deadline.cap(TELEMETRY_FLUSH), flush)
        .await
        .is_err()
    {
        tracing::warn!(
            scope = "Telemetry",
            "telemetry flush cut short; queued events ship next launch"
        );
    }
    Ok(())
}

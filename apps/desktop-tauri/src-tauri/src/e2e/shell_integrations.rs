use std::sync::Arc;

use memry_desktop::shell::flush::FLUSH_WINDOW_TIMEOUT;
use memry_desktop::shell::shutdown::Deadline;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::flush::FlushService;
use crate::shutdown::ShutdownService;

fn invalid(code: &'static str, message: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Invalid, code, message.to_string())
}

/// Makes step `step` of the next quit never finish, so a spec can watch the overrun path: the
/// hard backstop, the marker stamp and the next launch's report.
#[tauri::command]
pub fn e2e_trigger_shutdown_overrun(app: AppHandle<Wry>, step: String) -> Result<(), CommandError> {
    app.state::<ShutdownService>()
        .register(&step, Arc::new(|_, _| Box::pin(std::future::pending())))
        .map_err(|error| invalid("e2e_shutdown_step", error))
}

/// Runs the real flush handshake against `label`: the event reaches the page and the page
/// answers with `flush_done`. False when it did not answer in time.
#[tauri::command]
pub async fn e2e_request_flush(app: AppHandle<Wry>, label: String) -> bool {
    app.state::<FlushService>()
        .request(&app, &label, Deadline::after(FLUSH_WINDOW_TIMEOUT))
        .await
}

/// Closes `label` the way its close button does, through `CloseRequested`.
#[tauri::command]
pub fn e2e_close_window(app: AppHandle<Wry>, label: String) -> Result<(), CommandError> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| invalid("e2e_window", format!("no window {label}")))?;
    window
        .close()
        .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_window", error.to_string()))
}

/// What the main window did around a close with the tray on.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayProbe {
    pub visible_before: bool,
    pub visible_after_close: bool,
    pub visible_after_restore: bool,
}

/// Turns the tray on, closes the main window and restores it through `restore` (`deep-link` sends
/// `memry://open`; `tray-off` turns the tray off). A hidden window cannot be driven by WebDriver,
/// so the whole sequence runs here and reports back.
#[tauri::command]
pub async fn e2e_tray_probe(
    app: AppHandle<Wry>,
    restore: String,
) -> Result<TrayProbe, CommandError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| invalid("e2e_window", "no main window"))?;
    let visible = || window.is_visible().unwrap_or(false);
    let settle = || tokio::time::sleep(std::time::Duration::from_millis(600));
    crate::tray::apply(&app, true);
    settle().await;
    let visible_before = visible();
    window
        .close()
        .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_window", error.to_string()))?;
    settle().await;
    let visible_after_close = visible();
    match restore.as_str() {
        "deep-link" => app
            .state::<crate::deep_link::DeepLinkRouter>()
            .handle(&app, "memry://open"),
        "tray-off" => crate::tray::apply(&app, false),
        other => return Err(invalid("e2e_tray_restore", other)),
    }
    settle().await;
    Ok(TrayProbe {
        visible_before,
        visible_after_close,
        visible_after_restore: visible(),
    })
}

/// What the global capture shortcut holds and how often it fired.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutState {
    pub configured: Option<String>,
    pub fallback: bool,
    pub presses: u64,
}

#[tauri::command]
pub fn e2e_global_shortcut_state(app: AppHandle<Wry>) -> ShortcutState {
    let service = app.state::<crate::shortcuts::ShortcutService>();
    let (configured, fallback) = service.held();
    ShortcutState {
        configured,
        fallback,
        presses: service.presses(),
    }
}

/// Presses the shortcut's handler as a key press would: the OS delivers the real key to nobody
/// in a headless run.
#[tauri::command]
pub fn e2e_fire_global_capture(app: AppHandle<Wry>) {
    app.state::<crate::shortcuts::ShortcutService>().press(&app);
}

/// Delivers a power event as the platform would: on macOS a real `NSWorkspace` notification
/// (`sleep`, `wake`, `poweroff`), so the observers are what is under test. Elsewhere the event
/// is published on the monitor, because a VM row covers the OS side.
#[tauri::command]
pub fn e2e_post_power_event(app: AppHandle<Wry>, kind: String) -> Result<(), CommandError> {
    use memry_desktop::shell::power::PowerEvent;
    let event = match kind.as_str() {
        "sleep" => PowerEvent::Suspend,
        "wake" => PowerEvent::Resume,
        "poweroff" => PowerEvent::SessionEnding,
        other => return Err(invalid("e2e_power_kind", other)),
    };
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        crate::power::post_workspace_notification(event);
    }
    #[cfg(not(target_os = "macos"))]
    app.state::<crate::power::PowerMonitor>().emit(event);
    Ok(())
}

/// Takes a word a spec added back out of the personal dictionary (macOS; a no-op elsewhere).
#[tauri::command]
pub fn e2e_forget_spelled_word(app: AppHandle<Wry>, word: String) {
    #[cfg(target_os = "macos")]
    crate::spell::unlearn(&app, &word);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, word);
}

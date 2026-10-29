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

/// Makes step `step` of the next quit take `ms` and then finish, so a spec can act while a quit
/// runs.
#[tauri::command]
pub fn e2e_slow_shutdown_step(
    app: AppHandle<Wry>,
    step: String,
    ms: u64,
) -> Result<(), CommandError> {
    let delay = std::time::Duration::from_millis(ms);
    app.state::<ShutdownService>()
        .register(
            &step,
            Arc::new(move |_, _| {
                Box::pin(async move {
                    tokio::time::sleep(delay).await;
                    Ok(())
                })
            }),
        )
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

/// Writes `general.minimizeToTray` through the settings command, so the tray follows the saved
/// value. The page writes its own `general` fields at startup and each write converges the tray
/// on the saved value, so a runtime-only `tray::apply` could be undone mid-probe.
async fn set_tray_setting(app: &AppHandle<Wry>, enabled: bool) -> Result<(), CommandError> {
    crate::commands::settings::settings_set_group(
        app.clone(),
        "general".to_owned(),
        serde_json::json!({ "minimizeToTray": enabled }),
    )
    .await
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
    set_tray_setting(&app, true).await?;
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
        "tray-off" => set_tray_setting(&app, false).await?,
        other => return Err(invalid("e2e_tray_restore", other)),
    }
    settle().await;
    Ok(TrayProbe {
        visible_before,
        visible_after_close,
        visible_after_restore: visible(),
    })
}

/// Turns the tray on and closes the main window, which then hides to the tray as its close
/// button does. True when the window ended up hidden. WebDriver still runs scripts in it.
#[tauri::command]
pub async fn e2e_hide_to_tray(app: AppHandle<Wry>) -> Result<bool, CommandError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| invalid("e2e_window", "no main window"))?;
    let settle = || tokio::time::sleep(std::time::Duration::from_millis(600));
    set_tray_setting(&app, true).await?;
    settle().await;
    window
        .close()
        .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_window", error.to_string()))?;
    settle().await;
    Ok(!window.is_visible().unwrap_or(true))
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

/// Plays a Windows sign-out: `WM_QUERYENDSESSION` to the main window, then `WM_ENDSESSION(TRUE)`
/// to the main window (`main`) or to tao's hidden event-target window (`event-target`), and
/// returns without waiting. Windows asks either one first, so a spec runs both: the quit sequence
/// has to finish before the process ends, whichever it was. `kill_webview` ends the WebView2
/// browser process between the two messages, as a real sign-out does (it ends itself on its own
/// `WM_ENDSESSION`).
#[tauri::command]
pub async fn e2e_send_session_end(
    app: AppHandle<Wry>,
    target: String,
    kill_webview: Option<bool>,
) -> Result<(), CommandError> {
    let event_target = match target.as_str() {
        "main" => false,
        "event-target" => true,
        other => return Err(invalid("e2e_session_end_target", other)),
    };
    #[cfg(windows)]
    {
        let window = crate::windows::registry::WindowRegistry::main_window(&app)
            .ok_or_else(|| invalid("e2e_no_main_window", "no main window"))?;
        let kill_browser = if kill_webview.unwrap_or(false) {
            Some(browser_process_id(&window).await?)
        } else {
            None
        };
        // Read after the await: an `HWND` is not `Send`, and a command's future must be.
        let main = window
            .hwnd()
            .map_err(|error| invalid("e2e_no_main_window", error))?;
        if !crate::power::post_sign_out(main, event_target, kill_browser) {
            return Err(invalid("e2e_no_event_target", "no event target window"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (&app, event_target, kill_webview);
        Err(invalid(
            "e2e_windows_only",
            "WM_ENDSESSION exists on Windows only",
        ))
    }
}

/// The id of the WebView2 browser process behind `window`.
#[cfg(windows)]
async fn browser_process_id(window: &tauri::WebviewWindow<Wry>) -> Result<u32, CommandError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let mut pid = 0_u32;
            // SAFETY: the controller and its core are live COM objects owned by the webview, used
            // on the main thread that `with_webview` runs on.
            let read = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.BrowserProcessId(&mut pid))
            };
            let _ = sender.send(read.map(|()| pid).map_err(|error| error.to_string()));
        })
        .map_err(|error| invalid("e2e_webview", error))?;
    receiver
        .await
        .map_err(|error| invalid("e2e_webview", error))?
        .map_err(|error| invalid("e2e_webview", error))
}

/// Writes `text` to `e2e-held-edit.txt` in the app data folder, durably. The e2e page's held edit
/// (`window.__memryE2eHoldEdit`) calls this only when the save registry is flushed, as a note
/// page's unsaved markdown reaches main only then.
#[tauri::command]
pub async fn e2e_save_held_edit(app: AppHandle<Wry>, text: String) -> Result<(), CommandError> {
    let path = app
        .state::<memry_desktop::paths::AppPaths>()
        .data_dir
        .join("e2e-held-edit.txt");
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&path)?;
        std::io::Write::write_all(&mut file, text.as_bytes())?;
        file.sync_all()
    })
    .await
    .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_held_edit", error.to_string()))?
    .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_held_edit", error.to_string()))?;
    tracing::info!(scope = "e2e", "held edit saved");
    Ok(())
}

/// Registers or removes the real login item, which the e2e gate otherwise keeps specs away from:
/// for a VM row that reads the Run value or the autostart file. Remove it again afterwards.
#[tauri::command]
pub fn e2e_apply_login_item(app: AppHandle<Wry>, enabled: bool) -> Result<(), CommandError> {
    crate::autostart::apply_to_os(&app, enabled)
}

/// Takes a word a spec added back out of the personal dictionary (macOS; a no-op elsewhere).
#[tauri::command]
pub fn e2e_forget_spelled_word(app: AppHandle<Wry>, word: String) {
    #[cfg(target_os = "macos")]
    crate::spell::unlearn(&app, &word);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, word);
}

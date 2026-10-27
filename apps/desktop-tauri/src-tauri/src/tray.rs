//! The tray icon and close-to-tray (`apps/desktop/src/main/tray.ts`). [`apply`] converges on the
//! `general.minimizeToTray` setting and runs at startup, on every vault status change and on
//! every write of the setting. A session with no tray host (a Linux desktop without a
//! StatusNotifier host or `libayatana-appindicator3`) leaves the setting on, logs a warning and
//! keeps the normal close behaviour, because a window hidden with no way back is worse.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use memry_desktop::shell::tray::should_hide_on_close;
use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, CloseRequestApi, Manager, Window, Wry};

use crate::commands::error::CommandError;
use crate::startup::{self, Stage};
use crate::windows::events::WindowEvents;
use crate::windows::registry::{WindowKind, WindowRegistry};

const TRAY_ID: &str = "main";
const SHOW_ID: &str = "tray-show";
const QUIT_ID: &str = "tray-quit";

#[derive(Default)]
pub struct TrayService {
    enabled: AtomicBool,
    active: AtomicBool,
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "register tray close handler", register);
    startup::register(Stage::Window, "apply tray", apply_from_settings);
}

fn register(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(TrayService::default());
    app.state::<WindowEvents>()
        .on_close_requested(Some(WindowKind::Main), Box::new(on_close_requested));
    Ok(())
}

/// Whether a close of the main window hides it now.
pub fn hides_on_close(app: &AppHandle<Wry>) -> bool {
    let service = app.state::<TrayService>();
    should_hide_on_close(
        service.enabled.load(Ordering::SeqCst),
        service.active.load(Ordering::SeqCst),
        startup::shutdown_started(),
    )
}

fn on_close_requested(window: &Window<Wry>, api: &CloseRequestApi) {
    let app = window.app_handle();
    if !hides_on_close(app) {
        return;
    }
    api.prevent_close();
    if let Err(error) = window.hide() {
        tracing::warn!(scope = "Tray", "could not hide the window: {error}");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_skip_taskbar(true);
}

/// Shows the main window the way the tray does: shown, restored, focused and back in the
/// taskbar. Every "bring the app forward" path calls it.
pub fn show_main_window(app: &AppHandle<Wry>) {
    let Some(window) = WindowRegistry::main_window(app) else {
        return;
    };
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_skip_taskbar(false);
    let shown = window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus());
    if let Err(error) = shown {
        tracing::warn!(scope = "Tray", "could not show the main window: {error}");
    }
}

/// Reads `general.minimizeToTray` from the open vault (off while none is open) and converges.
pub fn apply_from_settings(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let enabled = app
        .state::<Session>()
        .current()
        .and_then(|vault| {
            app.state::<SettingsService>()
                .read_group(Some(&vault), "general")
                .ok()
        })
        .is_some_and(|read| read.value.get("minimizeToTray") == Some(&Value::Bool(true)));
    apply(app, enabled);
    Ok(())
}

/// Converges on `enabled`; safe to call repeatedly. AppKit and the Windows shell own the icon on
/// the main thread: dropping one anywhere else traps in `NSStatusBar`, so the work runs there.
pub fn apply(app: &AppHandle<Wry>, enabled: bool) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || converge(&handle, enabled)) {
        tracing::warn!(scope = "Tray", "could not reach the main thread: {error}");
    }
}

fn converge(app: &AppHandle<Wry>, enabled: bool) {
    let service = app.state::<TrayService>();
    service.enabled.store(enabled, Ordering::SeqCst);
    if enabled {
        if service.active.load(Ordering::SeqCst) {
            return;
        }
        let built = catch_unwind(AssertUnwindSafe(|| create(app)))
            .unwrap_or_else(|_| Err("the tray backend panicked".to_owned()));
        match built {
            Ok(()) => {
                service.active.store(true, Ordering::SeqCst);
                tracing::info!(scope = "Tray", "tray created");
            }
            Err(error) => tracing::warn!(
                scope = "Tray",
                "tray unavailable, close-to-tray disabled on this machine: {error}"
            ),
        }
        return;
    }
    if service.active.swap(false, Ordering::SeqCst) {
        destroy(app);
        // A window hidden under the old setting would otherwise be unreachable.
        show_main_window(app);
    }
}

/// Removes the icon; main thread only (see [`apply`]). Windows keeps a ghost icon until it is hovered when the process exits with
/// a live tray, so the exit path calls this too.
pub fn destroy(app: &AppHandle<Wry>) {
    if app.remove_tray_by_id(TRAY_ID).is_some() {
        tracing::info!(scope = "Tray", "tray destroyed");
    }
}

fn label(app: &AppHandle<Wry>, key: &str) -> String {
    let locale = app.state::<Arc<LocaleService>>().get();
    i18n::t(locale, key, &Args::new())
}

fn create(app: &AppHandle<Wry>) -> Result<(), String> {
    let text = |error: tauri::Error| error.to_string();
    let quit_key = if cfg!(windows) {
        "menu:app.exit"
    } else {
        "menu:app.quit"
    };
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(
                app,
                SHOW_ID,
                label(app, "menu:tray.show"),
                true,
                None::<&str>,
            )
            .map_err(text)?,
            &PredefinedMenuItem::separator(app).map_err(text)?,
            &MenuItem::with_id(app, QUIT_ID, label(app, quit_key), true, None::<&str>)
                .map_err(text)?,
        ],
    )
    .map_err(text)?;
    #[cfg(target_os = "macos")]
    let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"));
    #[cfg(not(target_os = "macos"))]
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"));
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.map_err(text)?)
        .menu(&menu)
        // A left click restores the window; the menu opens on the right click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_ID => show_main_window(app),
            QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    // Linux tray hosts have no click events and no tooltip: the menu is the only path.
    #[cfg(not(target_os = "linux"))]
    let builder = builder.tooltip("MemryNote");
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    builder.build(app).map(|_| ()).map_err(text)
}

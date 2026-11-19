//! One running instance per profile. A second launch hands its arguments to the first and exits;
//! the deep-link feature of the plugin forwards a `memry://` argument to the deep-link plugin
//! before the callback runs, so this module scans no argv. The callback only brings a window
//! forward: the startup-error window when one shows, else the preboot window (the first-launch
//! migration, which pauses the boot before the main window exists), else the main window through
//! the tray path, which also restores a window hidden to the tray. A first instance that the macOS relaunch guard
//! halted opens the app again once it exits (`updater::relaunch_guard`, #3773).
//!
//! Instances of different devices already differ by identifier (`paths::profile_identifier`), so
//! they do not collide. An open e2e gate registers no plugin at all: control-file instances run
//! side by side.

use tauri::{AppHandle, Builder, Manager, Runtime, WebviewWindow, Wry};

use crate::windows::registry::WindowKind;

/// Adds the single-instance plugin. It must be the first plugin of the app.
pub fn install(builder: Builder<Wry>, e2e_gate_open: bool) -> Builder<Wry> {
    if e2e_gate_open {
        return builder;
    }
    builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        crate::updater::relaunch_guard::note_handed_over();
        match window_to_raise(app) {
            Some(window) => raise(&window),
            None => crate::tray::show_main_window(app),
        }
    }))
}

/// The window a second launch brings forward, before the main window: the startup-error
/// window, else the preboot window. `None` leaves it to the main window.
pub fn window_to_raise<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    [WindowKind::StartupError, WindowKind::Preboot]
        .into_iter()
        .find_map(|kind| app.get_webview_window(&kind.label(0)))
}

/// Shows, restores and focuses `window`.
pub(crate) fn raise(window: &WebviewWindow<Wry>) {
    if let Err(error) = window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
    {
        tracing::warn!(scope = "Window", "{} not raised: {error}", window.label());
    }
}

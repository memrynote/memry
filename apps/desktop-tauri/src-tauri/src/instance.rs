//! One running instance per profile. A second launch hands its arguments to the first and exits;
//! the deep-link feature of the plugin forwards a `memry://` argument to the deep-link plugin
//! before the callback runs, so this module scans no argv. The callback only brings a window
//! forward: the startup-error window when one shows, else the main window through the tray path,
//! which also restores a window hidden to the tray.
//!
//! Instances of different devices already differ by identifier (`paths::profile_identifier`), so
//! they do not collide. An open e2e gate registers no plugin at all: control-file instances run
//! side by side.

use tauri::{Builder, Wry};

/// Adds the single-instance plugin. It must be the first plugin of the app.
pub fn install(builder: Builder<Wry>, e2e_gate_open: bool) -> Builder<Wry> {
    if e2e_gate_open {
        return builder;
    }
    builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if !crate::windows::startup_error::raise(app) {
            crate::tray::show_main_window(app);
        }
    }))
}

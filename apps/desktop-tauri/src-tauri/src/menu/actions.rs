//! The menu items the shell runs itself: roles muda lacks, the links, Back and Forward.

use std::collections::HashMap;

use memry_desktop::shell::menu_spec::{Action, MenuNode};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_opener::OpenerExt;

use super::target_window;
use crate::events::{AppNavigationRequestedEvent, send_to};
use crate::shell::dialogs;
use crate::windows::registry::WindowRegistry;

/// Every action item of a tree, by item id.
pub fn collect(tree: &[MenuNode]) -> HashMap<String, Action> {
    let mut actions = HashMap::new();
    let mut stack: Vec<&MenuNode> = tree.iter().collect();
    while let Some(node) = stack.pop() {
        match node {
            MenuNode::Action { id, action, .. } => {
                actions.insert(id.clone(), action.clone());
            }
            MenuNode::Submenu { items, .. } => stack.extend(items.iter()),
            _ => {}
        }
    }
    actions
}

fn window(app: &AppHandle<Wry>) -> Option<WebviewWindow<Wry>> {
    target_window(app).or_else(|| WindowRegistry::main_window(app))
}

pub fn run(app: &AppHandle<Wry>, action: &Action) {
    match action {
        Action::NavBack => navigate(app, "back"),
        Action::NavForward => navigate(app, "forward"),
        Action::Reload => {
            if let Some(window) = window(app)
                && let Err(error) = window.reload()
            {
                tracing::warn!(scope = "Menu", "reload failed: {error}");
            }
        }
        Action::ToggleDevTools => toggle_devtools(app),
        Action::PasteAndMatchStyle => paste_plain(app),
        Action::Delete => eval(app, "document.execCommand('delete')"),
        Action::StartSpeaking => speak(app, true),
        Action::StopSpeaking => speak(app, false),
        Action::ZoomWindow => zoom_window(app),
        Action::AboutDialog => about_dialog(app),
        Action::OpenUrl(url) => {
            if let Err(error) = app.opener().open_url(url, None::<&str>) {
                tracing::warn!(scope = "Menu", "the link did not open: {error}");
            }
        }
    }
}

#[cfg(debug_assertions)]
fn toggle_devtools(app: &AppHandle<Wry>) {
    if let Some(window) = window(app) {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
}

/// A release build has no inspector, and its menu lists no Toggle Developer Tools item.
#[cfg(not(debug_assertions))]
fn toggle_devtools(_app: &AppHandle<Wry>) {}

fn navigate(app: &AppHandle<Wry>, direction: &str) {
    if let Some(window) = target_window(app) {
        send_to(
            app,
            window.label(),
            AppNavigationRequestedEvent {
                direction: direction.to_owned(),
            },
        );
    }
}

fn eval(app: &AppHandle<Wry>, script: &str) {
    if let Some(window) = window(app) {
        eval_in(&window, script);
    }
}

fn eval_in(window: &WebviewWindow<Wry>, script: &str) {
    if let Err(error) = window.eval(script) {
        tracing::warn!(scope = "Menu", "the editing command failed: {error}");
    }
}

/// Paste the clipboard text without its formatting, into the window the item targeted. The menu
/// runs on the main thread, where the clipboard must not be read (`shell::clipboard`).
fn paste_plain(app: &AppHandle<Wry>) {
    let Some(window) = window(app) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let text = crate::shell::clipboard::read_text(&app).await;
        if text.is_empty() {
            return;
        }
        let literal = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".to_owned());
        eval_in(
            &window,
            &format!("document.execCommand('insertText', false, {literal})"),
        );
    });
}

fn zoom_window(app: &AppHandle<Wry>) {
    let Some(window) = window(app) else { return };
    let result = if window.is_maximized().unwrap_or(false) {
        window.unmaximize()
    } else {
        window.maximize()
    };
    if let Err(error) = result {
        tracing::warn!(scope = "Menu", "zoom failed: {error}");
    }
}

/// The Windows About box: a dialog with the version, off the main thread because it blocks.
fn about_dialog(app: &AppHandle<Wry>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let locale = app
            .state::<std::sync::Arc<memry_desktop::locale::LocaleService>>()
            .get();
        let t = |key: &str, args: &memry_desktop::i18n::Args| {
            memry_desktop::i18n::t(locale, &format!("menu:{key}"), args)
        };
        let mut args = memry_desktop::i18n::Args::new();
        args.insert(
            "version".to_owned(),
            memry_desktop::i18n::Arg::Str(app.package_info().version.to_string()),
        );
        let none = memry_desktop::i18n::Args::new();
        dialogs::confirm(
            &app,
            &t("help.about", &none),
            "MemryNote",
            &t("help.aboutVersion", &args),
            "OK",
            &t("window.close", &none),
        );
    });
}

#[cfg(target_os = "macos")]
fn speak(app: &AppHandle<Wry>, start: bool) {
    use objc2::{MainThreadMarker, sel};
    use objc2_app_kit::NSApplication;

    let result = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let selector = if start {
            sel!(startSpeaking:)
        } else {
            sel!(stopSpeaking:)
        };
        // SAFETY: a nil target sends the action up the responder chain, as the Electron role
        // did; nothing is retained.
        unsafe {
            NSApplication::sharedApplication(mtm).sendAction_to_from(selector, None, None);
        }
    });
    if let Err(error) = result {
        tracing::warn!(scope = "Menu", "speech was not toggled: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
fn speak(_app: &AppHandle<Wry>, _start: bool) {}

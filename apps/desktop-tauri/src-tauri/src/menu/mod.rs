//! The application menu. `memry_desktop::shell::menu_spec` holds its structure as data;
//! `native.rs` turns that into a muda menu, `actions.rs` runs the items the renderer does not,
//! and `popup.rs` shows context menus.
//!
//! macOS sets the menu on the app. Linux attaches it to the main window and hides it; Alt
//! shows it (`menu_toggle_alt`), so the menu bar auto-hides as Electron's `autoHideMenuBar`
//! did. Windows attaches nothing: Alt pops the menu up as a list at the title row.

mod actions;
mod native;
pub mod popup;

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use memry_desktop::locale::LocaleService;
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use memry_desktop::shell::accelerator::Binding;
#[cfg(feature = "e2e")]
use memry_desktop::shell::menu_spec::MenuNode;
use memry_desktop::shell::menu_spec::{Action, MenuInput, Platform, build_menu};
use tauri::menu::{Menu, MenuEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::events::{MenuCommandInvokedEvent, send_to};
use crate::windows::registry::WindowRegistry;

pub const fn platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::Mac
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

#[derive(Default)]
struct Built {
    /// The JSON of the keyboard overrides the menu was built with.
    signature: Option<String>,
    menu: Option<Menu<Wry>>,
    /// What `e2e_menu_tree` reads.
    #[cfg(feature = "e2e")]
    tree: Vec<MenuNode>,
    actions: HashMap<String, Action>,
}

#[derive(Default)]
pub struct MenuService {
    built: Mutex<Built>,
    /// Linux: the attached menu bar is showing.
    bar_shown: AtomicBool,
    /// Linux: `rehide_after_show` is connected to the main window.
    #[cfg(target_os = "linux")]
    show_hooked: AtomicBool,
}

fn overrides(app: &AppHandle<Wry>) -> BTreeMap<String, Binding> {
    let vault = app.state::<Session>().current();
    let read = app
        .state::<SettingsService>()
        .read_group(vault.as_ref(), "keyboard");
    let value = match read {
        Ok(read) => read.value,
        Err(error) => {
            tracing::warn!(scope = "Menu", "keyboard rebinds were not read: {error}");
            return BTreeMap::new();
        }
    };
    value
        .get("overrides")
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(id, binding)| {
                    serde_json::from_value(binding.clone())
                        .ok()
                        .map(|b| (id.clone(), b))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Rebuilds the menu when the keyboard rebinds changed since the last build, or always with
/// `force` (a language change relabels every item).
pub fn apply(app: &AppHandle<Wry>, force: bool) {
    let Some(service) = app.try_state::<MenuService>() else {
        return;
    };
    let overrides = overrides(app);
    let signature = serde_json::to_string(&overrides).unwrap_or_default();
    {
        let built = service.built.lock().unwrap_or_else(PoisonError::into_inner);
        if !force && built.signature.as_deref() == Some(signature.as_str()) && built.menu.is_some()
        {
            return;
        }
    }
    let locale = app.state::<Arc<LocaleService>>().get();
    let translate =
        |key: &str| memry_desktop::i18n::t(locale, &format!("menu:{key}"), &Default::default());
    let tree = build_menu(&MenuInput {
        platform: platform(),
        overrides: &overrides,
        t: &translate,
        // wry compiles the inspector into debug builds only (no `devtools` cargo feature).
        devtools: cfg!(debug_assertions),
    });
    let menu = match native::build(app, &tree) {
        Ok(menu) => menu,
        Err(error) => {
            tracing::error!(
                scope = "Menu",
                "the application menu was not built: {error}"
            );
            return;
        }
    };
    let actions = actions::collect(&tree);
    attach(app, &service, &menu);
    let mut built = service.built.lock().unwrap_or_else(PoisonError::into_inner);
    *built = Built {
        signature: Some(signature),
        menu: Some(menu),
        #[cfg(feature = "e2e")]
        tree,
        actions,
    };
}

#[cfg(target_os = "macos")]
fn attach(app: &AppHandle<Wry>, _service: &MenuService, menu: &Menu<Wry>) {
    if let Err(error) = app.set_menu(menu.clone()) {
        tracing::error!(scope = "Menu", "the menu was not set: {error}");
    }
}

#[cfg(target_os = "linux")]
fn attach(app: &AppHandle<Wry>, service: &MenuService, menu: &Menu<Wry>) {
    let Some(window) = WindowRegistry::main_window(app) else {
        return;
    };
    if let Err(error) = window.set_menu(menu.clone()) {
        tracing::error!(scope = "Menu", "the menu was not set: {error}");
        return;
    }
    // `autoHideMenuBar`: hidden until Alt.
    if let Err(error) = window.hide_menu() {
        tracing::warn!(scope = "Menu", "the menu bar was not hidden: {error}");
    }
    service.bar_shown.store(false, Ordering::Relaxed);
    if !service.show_hooked.swap(true, Ordering::Relaxed) {
        let app = app.clone();
        let label = window.label().to_owned();
        let queued = window.run_on_main_thread(move || rehide_after_show(&app, &label));
        if let Err(error) = queued {
            tracing::warn!(
                scope = "Menu",
                "the menu bar show hook was not queued: {error}"
            );
        }
    }
}

/// tao shows a window with `gtk_widget_show_all`, which shows the hidden menu bar with it, so
/// the bar appeared at the first reveal and the first bare Alt hid it instead of showing it.
/// After every show of the window the bar is hidden again unless Alt opened it. Runs on the
/// main thread, which owns the GTK window.
#[cfg(target_os = "linux")]
fn rehide_after_show(app: &AppHandle<Wry>, label: &str) {
    use webkit2gtk::glib::prelude::ObjectExt;

    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let gtk_window = match window.gtk_window() {
        Ok(gtk_window) => gtk_window,
        Err(error) => {
            tracing::warn!(
                scope = "Menu",
                "the menu bar show hook was not connected: {error}"
            );
            return;
        }
    };
    let app = app.clone();
    let label = label.to_owned();
    gtk_window.connect_local("show", true, move |_| {
        let shown = app
            .try_state::<MenuService>()
            .is_some_and(|service| service.bar_shown.load(Ordering::Relaxed));
        if !shown
            && let Some(window) = app.get_webview_window(&label)
            && let Err(error) = window.hide_menu()
        {
            tracing::warn!(
                scope = "Menu",
                "the menu bar was not hidden after show: {error}"
            );
        }
        None
    });
}

#[cfg(windows)]
fn attach(_app: &AppHandle<Wry>, _service: &MenuService, _menu: &Menu<Wry>) {}

/// Alt pressed and released alone. Linux shows or hides the menu bar; Windows pops the menu up
/// at the title row. Returns whether a menu is showing.
pub fn toggle_alt(app: &AppHandle<Wry>) -> bool {
    let Some(service) = app.try_state::<MenuService>() else {
        return false;
    };
    let Some(window) = WindowRegistry::main_window(app) else {
        return false;
    };
    if cfg!(target_os = "linux") {
        let show = !service.bar_shown.load(Ordering::Relaxed);
        let result = if show {
            window.show_menu()
        } else {
            window.hide_menu()
        };
        match result {
            Ok(()) => service.bar_shown.store(show, Ordering::Relaxed),
            Err(error) => tracing::warn!(scope = "Menu", "the menu bar was not toggled: {error}"),
        }
        return service.bar_shown.load(Ordering::Relaxed);
    }
    if cfg!(windows) {
        let menu = service
            .built
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .menu
            .clone();
        if let Some(menu) = menu {
            use tauri::menu::ContextMenu;
            let position = tauri::LogicalPosition::new(0.0, 36.0);
            if let Err(error) = menu.popup_at(window.as_ref().window(), position) {
                tracing::warn!(scope = "Menu", "the menu was not shown: {error}");
            }
        }
    }
    false
}

/// Escape or a blur: hides the Linux menu bar again.
pub fn hide_bar(app: &AppHandle<Wry>) {
    let Some(service) = app.try_state::<MenuService>() else {
        return;
    };
    if cfg!(target_os = "linux")
        && service.bar_shown.swap(false, Ordering::Relaxed)
        && let Some(window) = WindowRegistry::main_window(app)
        && let Err(error) = window.hide_menu()
    {
        tracing::warn!(scope = "Menu", "the menu bar was not hidden: {error}");
    }
}

/// The window a menu command goes to: the focused app window, else the only visible one, else
/// none (a command is dropped rather than sent to a guess).
pub fn target_window(app: &AppHandle<Wry>) -> Option<tauri::WebviewWindow<Wry>> {
    let windows = WindowRegistry::app_windows(app);
    if let Some(focused) = windows.iter().find(|w| w.is_focused().unwrap_or(false)) {
        return Some(focused.clone());
    }
    let mut visible = windows
        .into_iter()
        .filter(|w| w.is_visible().unwrap_or(false));
    let first = visible.next()?;
    visible.next().is_none().then_some(first)
}

/// The app-level `on_menu_event`: context menu choices, shell actions and bridge commands.
pub fn on_menu_event(app: &AppHandle<Wry>, event: MenuEvent) {
    let id = event.id().as_ref();
    if popup::resolve(app, id) {
        return;
    }
    let Some(service) = app.try_state::<MenuService>() else {
        return;
    };
    let action = service
        .built
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .actions
        .get(id)
        .cloned();
    if let Some(action) = action {
        actions::run(app, &action);
        return;
    }
    if let Some(window) = target_window(app) {
        send_to(
            app,
            window.label(),
            MenuCommandInvokedEvent {
                command: id.to_owned(),
            },
        );
    }
}

/// What the e2e build reads: the built tree.
#[cfg(feature = "e2e")]
pub fn tree(app: &AppHandle<Wry>) -> Vec<MenuNode> {
    app.try_state::<MenuService>()
        .map(|s| {
            s.built
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .tree
                .clone()
        })
        .unwrap_or_default()
}

/// Runs an item as a click would, for specs: native menus cannot be clicked by WebDriver.
#[cfg(feature = "e2e")]
pub fn activate(app: &AppHandle<Wry>, id: &str) {
    on_menu_event(
        app,
        MenuEvent {
            id: tauri::menu::MenuId::new(id),
        },
    );
}

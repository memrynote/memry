//! `memry://` links. The OS registers the scheme (the deep-link plugin; `register_all` at every
//! start on Windows and Linux, `CFBundleURLTypes` from `tauri.conf.json` on macOS) and hands the
//! URL to [`DeepLinkRouter::handle`] from every source: a cold start, a warm start, a second
//! launch. A link that arrives before the main window has painted is queued, never dropped
//! (Electron dropped it). The URL table is `memry_desktop::shell::deep_link`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::session::Session;
use memry_desktop::shell::deep_link::{self, DeepLink, PendingLinks};
use memry_desktop::telemetry::service::Service;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::commands::error::CommandError;
use crate::events::{InboxOpenItemEvent, SettingsOpenSectionEvent, broadcast};
use crate::startup::{self, Stage};
use crate::windows::registry::WindowRegistry;

/// Runs when a link of the registered target is delivered. Steps 20 (#3537) and 27 (#3544)
/// register theirs.
pub type DeepLinkHandler = Arc<dyn Fn(&AppHandle<Wry>, &DeepLink) + Send + Sync>;

#[derive(Default)]
pub struct DeepLinkRouter {
    pending: Mutex<PendingLinks>,
    ready: AtomicBool,
    handlers: Mutex<HashMap<&'static str, DeepLinkHandler>>,
}

pub fn register_stages() {
    startup::register(Stage::Plugins, "register deep links", register);
}

fn register(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(DeepLinkRouter::default());
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle
                .state::<DeepLinkRouter>()
                .handle(&handle, url.as_str());
        }
    });
    #[cfg(any(windows, target_os = "linux"))]
    {
        // Points the scheme at the running exe (HKCU on Windows, a `.desktop` handler and
        // `xdg-mime` on Linux, which an AppImage needs).
        if let Err(error) = app.deep_link().register_all() {
            tracing::warn!(
                scope = "DeepLink",
                "could not register the memry:// scheme: {error}"
            );
        }
        // The URL of a cold start arrives as an argument.
        match app.deep_link().get_current() {
            Ok(Some(urls)) => {
                for url in urls {
                    app.state::<DeepLinkRouter>().handle(app, url.as_str());
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(scope = "DeepLink", "could not read the launch URL: {error}")
            }
        }
    }
    Ok(())
}

impl DeepLinkRouter {
    /// Registers the handler for `target` (`DeepLink::target`); a later call replaces it.
    pub fn on(&self, target: &'static str, handler: DeepLinkHandler) {
        self.handlers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(target, handler);
    }

    /// Counts and routes `url`. Anything that is not a `memry:` URL is ignored.
    pub fn handle(&self, app: &AppHandle<Wry>, url: &str) {
        let Some(link) = deep_link::parse(url) else {
            return;
        };
        // The coarse target ships, never the URL, which can carry ids and OAuth parameters.
        track(app, &link);
        if self.ready.load(Ordering::SeqCst) && WindowRegistry::main_window(app).is_some() {
            self.deliver(app, &link);
            return;
        }
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(url);
        #[cfg(target_os = "macos")]
        if self.ready.swap(false, Ordering::SeqCst) {
            // The window was closed (macOS keeps the app alive): build it again, and the link
            // is delivered at its first paint.
            crate::windows::main_window::reopen(app);
        }
    }

    /// The main window painted: delivers what was queued, and everything after goes straight
    /// through.
    pub fn on_first_paint(&self, app: &AppHandle<Wry>) {
        self.ready.store(true, Ordering::SeqCst);
        let (queued, dropped) = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain();
        if dropped > 0 {
            tracing::warn!(
                scope = "DeepLink",
                "dropped {dropped} queued links over the limit"
            );
        }
        for url in queued {
            if let Some(link) = deep_link::parse(&url) {
                self.deliver(app, &link);
            }
        }
    }

    fn handler(&self, link: &DeepLink) -> Option<DeepLinkHandler> {
        self.handlers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(link.target())
            .cloned()
    }

    fn deliver(&self, app: &AppHandle<Wry>, link: &DeepLink) {
        crate::tray::show_main_window(app);
        match link {
            DeepLink::Open { item_id } => {
                tracing::info!(scope = "DeepLink", "launch requested via memry://open");
                // No vault open: the page has no inbox to focus, so only the window comes forward.
                if let Some(item_id) = item_id
                    && app.state::<Session>().current().is_some()
                {
                    broadcast(
                        app,
                        InboxOpenItemEvent {
                            item_id: item_id.clone(),
                        },
                    );
                }
            }
            DeepLink::BillingStart | DeepLink::BillingComplete { .. } => {
                broadcast(
                    app,
                    SettingsOpenSectionEvent {
                        section: "account".to_owned(),
                    },
                );
                self.run_handler(app, link);
            }
            DeepLink::Pair => self.confirm_pair(app, link),
            DeepLink::OAuth { .. } => tracing::info!(
                scope = "DeepLink",
                "an OAuth link arrived; nothing waits for one, so the window only came forward"
            ),
            // The renderer resolves these itself (`lib/memry-links.ts`).
            DeepLink::InContent(_) | DeepLink::Billing | DeepLink::Unknown => {}
        }
    }

    fn run_handler(&self, app: &AppHandle<Wry>, link: &DeepLink) {
        match self.handler(link) {
            Some(handler) => handler(app, link),
            None => tracing::info!(
                scope = "DeepLink",
                "no handler for {}; the window only came forward",
                link.target()
            ),
        }
    }

    /// Asks before pairing, as the Electron dialog does, then runs the `pair` handler.
    fn confirm_pair(&self, app: &AppHandle<Wry>, link: &DeepLink) {
        let Some(handler) = self.handler(link) else {
            tracing::info!(
                scope = "DeepLink",
                "no handler for pair; the window only came forward"
            );
            return;
        };
        let (app, link) = (app.clone(), link.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let locale = app.state::<Arc<LocaleService>>().get();
            let t = |key: &str| i18n::t(locale, key, &Args::new());
            let confirmed = crate::shell::dialogs::confirm(
                &app,
                &t("system:dialog.pair.title"),
                &t("system:dialog.pair.message"),
                "",
                &t("system:dialog.pair.buttonPair"),
                &t("common:button.cancel"),
            );
            if confirmed {
                handler(&app, &link);
            }
        });
    }
}

fn track(app: &AppHandle<Wry>, link: &DeepLink) {
    let Some(service) = crate::shell::services::telemetry(app) else {
        return;
    };
    let mut event = Service::event("deep_link_opened", "app", "opened");
    event.dimensions = Some([("target".to_owned(), link.target().to_owned())].into());
    service.track_main_event(event);
}

/// The renderer painted the main window's first frame.
pub fn on_first_paint(app: &AppHandle<Wry>) {
    if let Some(router) = app.try_state::<DeepLinkRouter>() {
        router.on_first_paint(app);
    }
}

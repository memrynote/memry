//! WebKitGTK's navigation policy names no frame, and wry answers it for every frame from the URL
//! alone (Tauri always installs a navigation handler, so wry's `decide-policy` handler is always
//! connected and claims every navigation action). What is left is after that policy:
//! - The response policy of the main frame's main resource (`is_main_frame_main_resource`) refuses
//!   every page but the app's, so no other document commits. wry answers navigation actions only
//!   and lets this decision through to the handler connected here.
//! - `load-failed` follows that refusal ("frame load interrupted") and any network failure of the
//!   main frame's load, with the URL it was loading. A page outside the app goes to the OS from
//!   here, once per navigation, and the signal is marked handled so WebKitGTK's default handler does
//!   not show its error page, with that URL, in place of the app. A load the app replaced with
//!   another (`Cancelled`) opens nothing.
//!
//! The response comes too late to be harmless: once the navigation policy said yes, WebKit runs the
//! page's `beforeunload` and stops all of its loads (`FrameLoader::continueLoadAfterNavigationPolicy`)
//! before the request is made. An in-flight `ipc://` fetch is aborted, and Tauri resends the
//! command over `postMessage`, so a command the shell already received can run twice. So on Linux
//! no main-frame navigation may start in the first place:
//! - No event of the app keeps a default action that navigates the top frame
//!   (`external-link-guard.ts`): link activation (`click`, `auxclick`; any button, modifier or
//!   Enter), any drag outside a text field (`dragenter`, `dragover`, `drop`; links, files, images,
//!   text) and form submission are cancelled unless a component claims them, and a web or mail
//!   link is opened in the OS by the renderer. The listeners sit on `window` in the capture phase,
//!   installed before the app renders, so no app handler that stops propagation hides an event.
//! - The context menu loses WebKitGTK's "Open Link" here ("Open Link in New Window" asks for a new
//!   window, which `on_new_window` sends to the OS).
//! - App code never navigates the window by script (no match in either renderer on 2026-10-28; the
//!   `memry/no-location-navigation` lint keeps it so: `location` and its parts, aliases, and
//!   `window.open` into the top frame), and untrusted content cannot run in the app's frame (CSP
//!   `script-src 'self'`; embeds are sandboxed frames).
//!
//! Two ways remain, both by a script of the app's own page, with those side effects:
//! - assigning `location` in a way the lint cannot see (a computed name, an alias it cannot
//!   follow), which reaches this late refusal;
//! - `location.reload()`, which the lint allows: the app page reloads, so nothing is refused, but
//!   the old page's `beforeunload` runs and its in-flight requests are cancelled all the same.
//!
//! `load-changed` STARTED cannot replace `load-failed`: for a navigation the page started, the
//! view's `uri` still names the app page at that point (WebKitGTK 2.52, checked on Ubuntu 24.04).
//! After a server redirect the URL that goes to the OS is the final one.

use memry_desktop::shell::frame_nav::{decide_main, is_app_page};
use tauri::{AppHandle, WebviewWindow, Wry};
use webkit2gtk::glib::prelude::Cast;
use webkit2gtk::{
    ContextMenuAction, ContextMenuExt, ContextMenuItemExt, NetworkError, PolicyDecisionExt,
    PolicyDecisionType, ResponsePolicyDecision, ResponsePolicyDecisionExt, URIRequestExt,
    WebViewExt,
};

pub fn install(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    let app = app.clone();
    let result = window.with_webview(move |webview| {
        let view = webview.inner();
        let origins = super::app_origins(&app);

        view.connect_context_menu(|_, menu, _, _| {
            for item in menu.items() {
                if item.stock_action() == ContextMenuAction::OpenLink {
                    menu.remove(&item);
                }
            }
            false
        });

        let response_origins = origins.clone();
        view.connect_decide_policy(move |_, decision, kind| {
            if kind != PolicyDecisionType::Response {
                return false;
            }
            let Some(response) = decision.downcast_ref::<ResponsePolicyDecision>() else {
                return false;
            };
            if !response.is_main_frame_main_resource()
                || response
                    .request()
                    .and_then(|request| request.uri())
                    .is_some_and(|uri| is_app_page(&uri, &response_origins))
            {
                return false;
            }
            decision.ignore();
            true
        });

        view.connect_load_failed(move |_, _, uri, error| {
            if is_app_page(uri, &origins) {
                return false;
            }
            if !error.matches(NetworkError::Cancelled) {
                let decision = super::with_guard(&app, &origins, |guard| decide_main(uri, guard));
                super::act(&app, uri, decision);
            }
            true
        });
    });
    if let Err(error) = result {
        tracing::error!(
            scope = "Navigation",
            "the main frame guard was not installed: {error}"
        );
    }
}

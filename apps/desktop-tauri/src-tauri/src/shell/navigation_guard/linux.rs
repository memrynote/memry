//! WebKitGTK's navigation policy names no frame, and wry answers it for every frame from the URL
//! alone. Three signals of the main frame do what that cannot:
//! - `load-changed` STARTED is the main frame's provisional load, before any response: a link
//!   leaving the app goes to the OS here, once per navigation.
//! - The response policy of the main frame's main resource (`is_main_frame_main_resource`) refuses
//!   every page but the app's, so no other document commits. wry answers navigation actions only
//!   and lets this decision through to the handler connected here.
//! - `load-failed` for a page outside the app is swallowed: WebKitGTK's default handler would show
//!   its error page, with the failed URL, in place of the app.
//!
//! None of these stops the app's own document or its loads (`webkit_web_view_stop_loading` would
//! cancel those too).

use memry_desktop::shell::frame_nav::{decide_main, is_app_page};
use tauri::{AppHandle, WebviewWindow, Wry};
use webkit2gtk::glib::prelude::Cast;
use webkit2gtk::{
    LoadEvent, PolicyDecisionExt, PolicyDecisionType, ResponsePolicyDecision,
    ResponsePolicyDecisionExt, URIRequestExt, WebViewExt,
};

pub fn install(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    let app = app.clone();
    let result = window.with_webview(move |webview| {
        let view = webview.inner();
        let origins = super::app_origins(&app);

        let started = app.clone();
        let started_origins = origins.clone();
        view.connect_load_changed(move |view, event| {
            if event != LoadEvent::Started {
                return;
            }
            let Some(uri) = view.uri() else { return };
            if !is_app_page(&uri, &started_origins) {
                let decision =
                    super::with_guard(&started, &started_origins, |guard| decide_main(&uri, guard));
                super::act(&started, &uri, decision);
            }
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

        view.connect_load_failed(move |_, _, uri, _| !is_app_page(uri, &origins));
    });
    if let Err(error) = result {
        tracing::error!(
            scope = "Navigation",
            "the main frame guard was not installed: {error}"
        );
    }
}

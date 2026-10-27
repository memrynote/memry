//! WebKitGTK's navigation policy names no frame, and wry answers it for every frame from the URL
//! alone. Two signals of the main frame do what that cannot:
//! - The response policy of the main frame's main resource (`is_main_frame_main_resource`) refuses
//!   every page but the app's, so no other document commits. wry answers navigation actions only
//!   and lets this decision through to the handler connected here.
//! - `load-failed` follows that refusal ("frame load interrupted") and any network failure of the
//!   main frame's load, with the URL it was loading. A page outside the app goes to the OS from
//!   here, once per navigation, and the signal is marked handled so WebKitGTK's default handler does
//!   not show its error page, with that URL, in place of the app. A load the app replaced with
//!   another (`Cancelled`) opens nothing.
//!
//! `load-changed` STARTED cannot do the second part: for a navigation the page started, the view's
//! `uri` still names the app page at that point (WebKitGTK 2.52, checked on Ubuntu 24.04). Neither
//! signal stops the app's own document or its loads (`webkit_web_view_stop_loading` would cancel
//! those too). After a server redirect the URL that goes to the OS is the final one.

use memry_desktop::shell::frame_nav::{decide_main, is_app_page};
use tauri::{AppHandle, WebviewWindow, Wry};
use webkit2gtk::glib::prelude::Cast;
use webkit2gtk::{
    NetworkError, PolicyDecisionExt, PolicyDecisionType, ResponsePolicyDecision,
    ResponsePolicyDecisionExt, URIRequestExt, WebViewExt,
};

pub fn install(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    let app = app.clone();
    let result = window.with_webview(move |webview| {
        let view = webview.inner();
        let origins = super::app_origins(&app);

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

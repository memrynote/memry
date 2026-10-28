//! WKWebView tells its navigation delegate which frame a navigation targets, but wry owns that
//! delegate and passes its handler the URL alone (`wkwebview/navigation.rs`), so the handler cannot
//! tell the main frame from a note's embed. This puts the main frame's decision in front of wry's
//! `webView:decidePolicyForNavigationAction:decisionHandler:`. A navigation of the main frame, or
//! one that asks for a new window (no target frame), is decided by `decide_main` before its request
//! is made: anything but the app is cancelled, and a link goes to the OS. The rest, and a download,
//! go on to wry's implementation, which asks `on_navigation`.
//!
//! The method is replaced on the delegate's class, once per process, and only when the class
//! defines it itself; otherwise the error is logged and `check_commit` is the only guard left.
//! Being per class, it decides the main frame of every webview wry builds in this process, not
//! only the main window's: each is an app page that must stay on the app (the sticky and quick
//! capture windows of Steps 27 and 31 included). A webview that should show anything else needs a
//! check of `webview` here before `decide_main`.

use std::sync::OnceLock;

use block2::Block;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use objc2_foundation::NSObjectProtocol;
use objc2_web_kit::{WKNavigationAction, WKNavigationActionPolicy, WKWebView};
use tauri::{AppHandle, WebviewWindow, Wry};

static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();
static WRY_DECIDE: OnceLock<Imp> = OnceLock::new();

type Decide = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut WKNavigationAction,
    *mut Block<dyn Fn(WKNavigationActionPolicy)>,
);

/// The main frame, or a new window (WebKit names no target frame for one).
fn targets_top_level(action: &WKNavigationAction) -> bool {
    // SAFETY: plain property reads of a live navigation action, on the main thread.
    unsafe { action.targetFrame().is_none_or(|frame| frame.isMainFrame()) }
}

/// A download never commits a document; wry decides it (`shouldPerformDownload`, macOS 11.3).
fn is_download(action: &WKNavigationAction) -> bool {
    // SAFETY: as above; the selector is checked before it is sent.
    unsafe {
        action.respondsToSelector(sel!(shouldPerformDownload)) && action.shouldPerformDownload()
    }
}

fn url_of(action: &WKNavigationAction) -> String {
    // SAFETY: as above.
    unsafe { action.request().URL().and_then(|url| url.absoluteString()) }
        .map(|url| url.to_string())
        .unwrap_or_default()
}

extern "C-unwind" fn decide_policy(
    this: *mut AnyObject,
    cmd: Sel,
    webview: *mut AnyObject,
    action: *mut WKNavigationAction,
    handler: *mut Block<dyn Fn(WKNavigationActionPolicy)>,
) {
    // SAFETY: WebKit calls the method with a live navigation action and decision handler.
    let (action_ref, handler_ref) = unsafe { (&*action, &*handler) };
    if let Some(app) = APP.get()
        && targets_top_level(action_ref)
        && !is_download(action_ref)
        && !super::main_frame_may_load(app, &url_of(action_ref))
    {
        handler_ref.call((WKNavigationActionPolicy::Cancel,));
        return;
    }
    match WRY_DECIDE.get() {
        // SAFETY: the implementation this one replaced, called with the arguments it was given.
        Some(wry) => unsafe {
            std::mem::transmute::<Imp, Decide>(*wry)(this, cmd, webview, action, handler)
        },
        None => handler_ref.call((WKNavigationActionPolicy::Cancel,)),
    }
}

fn replace(class: &AnyClass) -> Result<(), &'static str> {
    if WRY_DECIDE.get().is_some() {
        return Ok(());
    }
    let selector = sel!(webView:decidePolicyForNavigationAction:decisionHandler:);
    // Replacing an inherited method would change the superclass and every other delegate.
    if !class
        .instance_methods()
        .iter()
        .any(|method| method.name() == selector)
    {
        return Err("the navigation delegate does not decide navigation actions itself");
    }
    let method = class
        .instance_method(selector)
        .ok_or("the navigation delegate has no decidePolicyForNavigationAction")?;
    // SAFETY: `decide_policy` has the method's signature (`v@:@@@?`), and both run on the main
    // thread only, so no decision is asked between the swap and the store below.
    let wry =
        unsafe { method.set_implementation(std::mem::transmute::<Decide, Imp>(decide_policy)) };
    WRY_DECIDE
        .set(wry)
        .map_err(|_| "the navigation delegate was replaced twice")
}

pub fn install(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    let _ = APP.set(app.clone());
    let result = window.with_webview(|webview| {
        // SAFETY: `inner()` is the window's live WKWebView, used on the main thread that
        // `with_webview` runs on.
        let view: &WKWebView = unsafe { &*webview.inner().cast() };
        let Some(delegate) = (unsafe { view.navigationDelegate() }) else {
            tracing::error!(
                scope = "Navigation",
                "the webview has no navigation delegate; only the commit check guards the window"
            );
            return;
        };
        let object: &AnyObject = delegate.as_ref();
        if let Err(reason) = replace(object.class()) {
            tracing::error!(
                scope = "Navigation",
                "{reason}; only the commit check guards the window"
            );
        }
    });
    if let Err(error) = result {
        tracing::error!(
            scope = "Navigation",
            "the main frame guard was not installed: {error}"
        );
    }
}

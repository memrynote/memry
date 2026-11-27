//! AppKit calls tao has no API for: the edge tab floats on every Space, full-screen ones included,
//! comes to the front without activating the app, and hears the pointer while it is not the key
//! window.

use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSFloatingWindowLevel, NSTrackingArea,
    NSTrackingAreaOptions, NSView, NSWindow, NSWindowCollectionBehavior,
};
use tauri::{WebviewWindow, Wry};

fn ns_window(window: &WebviewWindow<Wry>) -> Option<&NSWindow> {
    let pointer = window
        .ns_window()
        .map_err(|error| tracing::warn!(scope = "StickyEdgeTab", "no NSWindow: {error}"))
        .ok()?;
    // SAFETY: tao's NSWindow, alive while `window` is; used on the main thread only.
    unsafe { pointer.cast::<NSWindow>().as_ref() }
}

/// Electron's `setAlwaysOnTop(true, 'floating')` and `setVisibleOnAllWorkspaces(true,
/// {visibleOnFullScreen: true})`. AppKit lets a window join another app's full-screen Space only
/// while the process is an accessory app, so the behaviour is set inside that transform, as
/// Electron does; the Dock icon may flicker once.
pub fn float_on_every_space(window: &WebviewWindow<Wry>) {
    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!(
            scope = "StickyEdgeTab",
            "edge tab set up off the main thread: it stays off full-screen Spaces"
        );
        return;
    };
    let Some(ns_window) = ns_window(window) else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    let policy = app.activationPolicy();
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    ns_window.setLevel(NSFloatingWindowLevel);
    ns_window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    app.setActivationPolicy(policy);
}

/// `showInactive`: in front of every window, the app left inactive.
pub fn show_inactive(window: &WebviewWindow<Wry>) {
    if MainThreadMarker::new().is_none() {
        tracing::warn!(
            scope = "StickyEdgeTab",
            "edge tab shown off the main thread"
        );
        return;
    }
    if let Some(ns_window) = ns_window(window) {
        ns_window.orderFrontRegardless();
    }
}

/// WKWebView follows the pointer only in the key window, and sees it enter only in the active app
/// (its `WKMouseTrackingObserver` areas), while the edge tab is never key and the user is usually
/// in another app: its page never saw the pointer and never fanned out. Those areas are replaced by
/// copies that track always, as Chromium's view does for Electron's tab.
pub fn track_pointer_unfocused(window: &WebviewWindow<Wry>) {
    let result = window.with_webview(|webview| {
        // SAFETY: `inner()` is the window's live WKWebView, used on the main thread that
        // `with_webview` runs on.
        let view: &NSView = unsafe { &*webview.inner().cast() };
        let pointer =
            NSTrackingAreaOptions::MouseMoved | NSTrackingAreaOptions::MouseEnteredAndExited;
        let when = NSTrackingAreaOptions::ActiveWhenFirstResponder
            | NSTrackingAreaOptions::ActiveInKeyWindow
            | NSTrackingAreaOptions::ActiveInActiveApp
            | NSTrackingAreaOptions::ActiveAlways;
        let mut replaced = 0;
        for area in view.trackingAreas() {
            let options = area.options();
            if !options.intersects(pointer) || options.contains(NSTrackingAreaOptions::ActiveAlways)
            {
                continue;
            }
            let owner = area.owner();
            let user_info = area.userInfo();
            // SAFETY: the same rect, owner and user info as WebKit's area; only when it is active
            // changes.
            let always = unsafe {
                NSTrackingArea::initWithRect_options_owner_userInfo(
                    NSTrackingArea::alloc(),
                    area.rect(),
                    options.difference(when) | NSTrackingAreaOptions::ActiveAlways,
                    owner.as_deref(),
                    user_info.as_deref(),
                )
            };
            view.removeTrackingArea(&area);
            view.addTrackingArea(&always);
            replaced += 1;
        }
        if replaced == 0 {
            tracing::warn!(
                scope = "StickyEdgeTab",
                "no pointer tracking area on the edge tab's webview: it fans out only once focused"
            );
        }
    });
    if let Err(error) = result {
        tracing::warn!(
            scope = "StickyEdgeTab",
            "edge tab pointer tracking not set: {error}"
        );
    }
}

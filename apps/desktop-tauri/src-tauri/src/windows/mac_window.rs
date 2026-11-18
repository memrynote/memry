//! AppKit calls tao has no API for: the edge tab floats on every Space, full-screen ones included,
//! and comes to the front without activating the app.

use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSFloatingWindowLevel, NSWindow,
    NSWindowCollectionBehavior,
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

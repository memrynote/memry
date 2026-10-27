//! Cmd+Q, Dock Quit and logout on macOS reach the app as `[NSApp terminate:]`. tao implements
//! only `applicationWillTerminate:`, which cannot be refused, so the process would end with no
//! flush, no vault close and a crash marker left behind. This adds `applicationShouldTerminate:`
//! to tao's app delegate: it cancels the termination and runs the app's own exit, which goes
//! through `RunEvent::ExitRequested` and the ordered sequence.

use std::sync::OnceLock;

use objc2::MainThreadMarker;
use objc2::ffi;
use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::sel;
use objc2_app_kit::NSApplication;
use tauri::{AppHandle, Wry};

use crate::commands::error::CommandError;

static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// `NSTerminateCancel`.
const TERMINATE_CANCEL: usize = 0;

extern "C-unwind" fn should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> usize {
    tracing::info!(scope = "Shutdown", "macOS asked the app to terminate");
    if let Some(app) = APP.get() {
        app.exit(0);
    }
    TERMINATE_CANCEL
}

pub fn install(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!(
            scope = "Shutdown",
            "not on the main thread; Cmd+Q will skip the shutdown sequence"
        );
        return Ok(());
    };
    let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
        tracing::warn!(
            scope = "Shutdown",
            "no app delegate; Cmd+Q will skip the shutdown sequence"
        );
        return Ok(());
    };
    // SAFETY: `delegate` is a live Objective-C object, and its class outlives this call. The
    // method added has the signature of `applicationShouldTerminate:` (`Q@:@`): it takes the
    // sender and returns an `NSApplicationTerminateReply`, an unsigned integer.
    let added = unsafe {
        let object: *const AnyObject = std::ptr::from_ref(&*delegate).cast();
        let class = (*object).class();
        let imp: Imp = std::mem::transmute::<
            extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            Imp,
        >(should_terminate);
        ffi::class_addMethod(
            std::ptr::from_ref(class).cast_mut().cast(),
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        tracing::warn!(
            scope = "Shutdown",
            "the app delegate already answers applicationShouldTerminate:"
        );
    }
    Ok(())
}

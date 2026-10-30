//! Cmd+Q, Dock Quit, a `quit` Apple event and Log Out reach the app as `[NSApp terminate:]`. tao
//! implements only `applicationWillTerminate:`, which cannot be refused, so the process would end
//! with no flush, no vault close and a crash marker left behind. This adds
//! `applicationShouldTerminate:` to tao's app delegate. It answers `NSTerminateLater` and starts
//! the ordered sequence; the sequence's clean end replies YES, and AppKit finishes the quit. The
//! quit is never refused: AppKit reports a refusal to the sender as `userCanceledErr` (-128), and
//! at Log Out or Restart loginwindow reads that as the app cancelling the session end. A sequence
//! that does not end cleanly ends the process through the forced exit and the hard backstop,
//! which let a session end go on as well.
//!
//! `terminate:` must not be sent from inside a tao callback (`run_on_main_thread`, an event
//! handler): AppKit waits for the reply in a nested run loop, and tao handles no events and cannot
//! run `applicationWillTerminate:` while its callback is on the stack. AppKit's menus and Apple
//! events send it from the run loop.

use std::sync::{Mutex, OnceLock, PoisonError};

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2::ffi;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{msg_send, sel};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use objc2_core_foundation::{CFRunLoop, kCFRunLoopCommonModes};
use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};
use tauri::{AppHandle, Wry};

use crate::commands::error::CommandError;

static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// Where the quit macOS asked for stands.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Terminate {
    /// No `terminate:` is waiting for an answer.
    Idle,
    /// `terminate:` was answered `NSTerminateLater`; the sequence's clean end replies YES.
    Pending,
    /// The clean end already happened: a later `terminate:` may go through at once.
    Exiting,
}

static STATE: Mutex<Terminate> = Mutex::new(Terminate::Idle);

fn state() -> std::sync::MutexGuard<'static, Terminate> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

extern "C-unwind" fn should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> NSApplicationTerminateReply {
    let reason = quit_reason();
    match &reason {
        Some(reason) => tracing::info!(
            scope = "Shutdown",
            "macOS asked the app to terminate (quit reason {reason})"
        ),
        None => tracing::info!(scope = "Shutdown", "macOS asked the app to terminate"),
    }
    let Some(app) = APP.get() else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    if reason.as_deref().is_some_and(is_session_end) {
        super::session_ending(app);
    }
    let mut state = state();
    match *state {
        Terminate::Exiting => NSApplicationTerminateReply::TerminateNow,
        Terminate::Pending => NSApplicationTerminateReply::TerminateLater,
        Terminate::Idle => {
            *state = Terminate::Pending;
            drop(state);
            // Not through `app.exit`: that request waits for tao's event loop, and the sequence
            // must start (and arm its backstop) whatever the loop is doing. A quit that already
            // runs (tray Quit, a signal) keeps running and replies when it ends.
            super::start(app, super::ShutdownReason::Quit);
            NSApplicationTerminateReply::TerminateLater
        }
    }
}

/// Whether loginwindow sent the quit because the session ends: `rlgo` (kAEReallyLogOut), `rest`
/// (kAERestart) or `shut` (kAEShutDown), the reasons `AERegistry.h` lists for `kAEQuitReason`.
/// The quit then installs no update. `power/mac.rs` turns install-on-quit off as well, from
/// `NSWorkspaceWillPowerOffNotification`, which also covers a Log Out during a running quit;
/// that AppKit posts it there was seen on macOS 27 only, so both signals stay.
fn is_session_end(reason: &str) -> bool {
    matches!(reason, "rlgo" | "rest" | "shut")
}

/// The `keyAEQuitReason` of the quit Apple event being handled, such as `rlgo` from loginwindow
/// at Log Out. Cmd+Q, Dock Quit and `quit app` give none. The reply never depends on it.
fn quit_reason() -> Option<String> {
    let event = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent()?;
    let keyword = u32::from_be_bytes(*b"why?");
    // SAFETY: both selectors take an `AEKeyword` (a `u32`) and return a descriptor or nil.
    let descriptor: Option<Retained<NSAppleEventDescriptor>> =
        unsafe { msg_send![&*event, attributeDescriptorForKeyword: keyword] };
    let descriptor =
        descriptor.or_else(|| unsafe { msg_send![&*event, paramDescriptorForKeyword: keyword] })?;
    Some(String::from_utf8_lossy(&descriptor.typeCodeValue().to_be_bytes()).into_owned())
}

/// The sequence ended cleanly. True when a `terminate:` waits for the answer and AppKit gets YES
/// on the main thread: AppKit then ends the process with code 0, so the caller must not exit as
/// well. False also when the answer could not be scheduled: the caller then exits itself. From
/// here a new `terminate:` goes through at once.
pub fn accept_pending() -> bool {
    let pending = std::mem::replace(&mut *state(), Terminate::Exiting) == Terminate::Pending;
    pending
        && on_main_run_loop(|app| {
            tracing::info!(scope = "Shutdown", "accepting the quit macOS asked for");
            app.replyToApplicationShouldTerminate(true);
        })
}

/// Sends `terminate:` from the run loop, as AppKit's menu does (for the e2e commands).
#[cfg(feature = "e2e")]
pub fn post_terminate() {
    on_main_run_loop(|app| app.terminate(None));
}

/// Runs `f` on the main run loop in its common modes, which include the modal panel mode AppKit
/// waits in for the reply. Neither GCD's main queue nor tao's `run_on_main_thread` would do: the
/// main queue runs nothing while one of its own blocks waits, and a reply sent from a tao
/// callback runs `applicationWillTerminate:` while tao's callback is still on the stack.
/// False, logged, when there is no main run loop to run it on.
fn on_main_run_loop(f: impl Fn(&NSApplication) + Send + 'static) -> bool {
    let Some(main) = CFRunLoop::main() else {
        tracing::error!(scope = "Shutdown", "no main run loop to answer macOS on");
        return false;
    };
    let block = RcBlock::new(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            f(&NSApplication::sharedApplication(mtm));
        }
    });
    // SAFETY: `kCFRunLoopCommonModes` is CoreFoundation's mode constant, and the block takes and
    // returns nothing, as `CFRunLoopPerformBlock` requires. The run loop copies the block.
    unsafe {
        main.perform_block(
            kCFRunLoopCommonModes.map(|mode| mode.as_ref()),
            Some(&block),
        );
    }
    main.wake_up();
    true
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
            extern "C-unwind" fn(
                *mut AnyObject,
                Sel,
                *mut AnyObject,
            ) -> NSApplicationTerminateReply,
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

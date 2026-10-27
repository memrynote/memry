//! A second window subclass on the main window (the caption one is `win32_caption.rs`) for
//! `WM_POWERBROADCAST` and the session-end messages.

use std::sync::Mutex;

use memry_desktop::shell::power::{PowerEvent, SleepEdges, wait_for};
use memry_desktop::shell::shutdown::SESSION_END_BUDGET;
use tauri::{AppHandle, Wry};
use tokio::sync::broadcast::Sender;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, MsgWaitForMultipleObjects, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    PBT_APMSUSPEND, PM_REMOVE, PeekMessageW, PostQuitMessage, QS_ALLINPUT, TranslateMessage,
    WM_ENDSESSION, WM_POWERBROADCAST, WM_QUERYENDSESSION, WM_QUIT,
};
use windows::core::w;

use crate::windows::registry::WindowRegistry;

const SUBCLASS_ID: usize = 0x4D45_4D50;

/// Leaked on purpose: the main window lives as long as the process.
struct Shared {
    app: AppHandle<Wry>,
    sender: Sender<PowerEvent>,
    edges: Mutex<SleepEdges>,
}

impl Shared {
    fn emit(&self, event: PowerEvent) {
        super::publish(&self.sender, event);
    }
}

unsafe extern "system" fn proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    refdata: usize,
) -> LRESULT {
    // SAFETY: `refdata` is the leaked `Shared` installed with this subclass.
    let shared = unsafe { &*(refdata as *const Shared) };
    match msg {
        WM_POWERBROADCAST => {
            let mut edges = shared
                .edges
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let event = match wparam.0 as u32 {
                PBT_APMSUSPEND => edges.suspend(),
                PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => edges.resume(),
                _ => None,
            };
            drop(edges);
            if let Some(event) = event {
                shared.emit(event);
            }
        }
        WM_QUERYENDSESSION => {
            shared.emit(PowerEvent::SessionEnding);
            // An update must not start installing as the machine goes down.
            if let Some(hook) = crate::shutdown::update_hook(&shared.app) {
                hook.disable_install_on_quit();
            }
            // Shown on the sign-out screen while the sequence runs, and what lets Windows hold
            // the session open for it.
            // SAFETY: `hwnd` is the window this procedure belongs to.
            if let Err(error) =
                unsafe { ShutdownBlockReasonCreate(hwnd, w!("MemryNote is saving your notes")) }
            {
                tracing::warn!(
                    scope = "Power",
                    "could not set the shutdown block reason: {error}"
                );
            }
            return LRESULT(1);
        }
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                crate::shutdown::begin_session_end(&shared.app);
                // Windows ends the process soon after this returns (about five seconds in all),
                // so the quit sequence has to finish here. The steps may need this thread (the
                // webview flush), so its messages keep being dispatched meanwhile.
                let done = wait_for(
                    SESSION_END_BUDGET,
                    || crate::shutdown::is_completed(&shared.app),
                    pump_messages,
                );
                if !done {
                    tracing::warn!(
                        scope = "Power",
                        "the session ended before the quit sequence"
                    );
                }
            } else if let Some(hook) = crate::shutdown::update_hook(&shared.app) {
                // The sign-out was cancelled: the install-on-quit decision is back.
                hook.enable_install_on_quit();
            }
            // SAFETY: `hwnd` is the window this procedure belongs to.
            let _ = unsafe { ShutdownBlockReasonDestroy(hwnd) };
            return LRESULT(0);
        }
        _ => {}
    }
    // SAFETY: forwards the message this procedure received.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Waits up to `slice` for input, then dispatches every message queued on this thread.
fn pump_messages(slice: std::time::Duration) {
    // SAFETY: plain Win32 message-loop calls on the thread that owns the window.
    unsafe {
        MsgWaitForMultipleObjects(
            None,
            false,
            u32::try_from(slice.as_millis()).unwrap_or(u32::MAX),
            QS_ALLINPUT,
        );
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            if msg.message == WM_QUIT {
                // The app asked to exit: hand the request back to the real loop.
                PostQuitMessage(i32::try_from(msg.wParam.0).unwrap_or(0));
                return;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Subclasses the main window. Runs on the thread that owns it.
pub fn start(app: &AppHandle<Wry>, sender: &Sender<PowerEvent>) {
    let Some(window) = WindowRegistry::main_window(app) else {
        tracing::warn!(
            scope = "Power",
            "no main window; sleep and session end are not heard"
        );
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        tracing::warn!(
            scope = "Power",
            "no window handle; sleep and session end are not heard"
        );
        return;
    };
    let shared: &'static Shared = Box::leak(Box::new(Shared {
        app: app.clone(),
        sender: sender.clone(),
        edges: Mutex::new(SleepEdges::default()),
    }));
    // SAFETY: the procedure and its refdata outlive the window.
    let ok =
        unsafe { SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, shared as *const _ as usize) };
    if !ok.as_bool() {
        tracing::warn!(scope = "Power", "the power subclass was not installed");
    }
}

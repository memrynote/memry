//! A second window subclass on the main window (the caption one is `win32_caption.rs`) for
//! `WM_POWERBROADCAST` and the session-end messages.

use std::sync::Mutex;

use memry_desktop::shell::power::{PowerEvent, SleepEdges};
use tauri::{AppHandle, Wry};
use tokio::sync::broadcast::Sender;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, WM_ENDSESSION, WM_POWERBROADCAST,
    WM_QUERYENDSESSION,
};

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
            return LRESULT(1);
        }
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                // Windows allows about five seconds: the sequence runs on a 4 s budget.
                crate::shutdown::begin_session_end(&shared.app);
            }
            return LRESULT(0);
        }
        _ => {}
    }
    // SAFETY: forwards the message this procedure received.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
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

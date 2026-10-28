//! Native hit testing for the React caption buttons (Windows). The page draws minimize,
//! maximize and close and reports their rectangles.
//!
//! WebView2's render widget belongs to `msedgewebview2.exe`, so no window procedure of this
//! process sees the mouse over the page. An input sink (`sink`), a child window of ours that
//! draws nothing, sits over the three buttons and answers `WM_NCHITTEST` with `HTMINBUTTON`,
//! `HTMAXBUTTON` or `HTCLOSE`: Windows 11 shows its snap-layout flyout over maximize, and the
//! buttons act through `WM_SYSCOMMAND`. The page gets no mouse events for them, so hover and
//! press travel as events.
//!
//! The top-level window's subclass places the sink after a resize and carries the browser back
//! and forward keys (`WM_APPCOMMAND`).

mod sink;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU8, Ordering};

use arc_swap::ArcSwap;
use memry_desktop::shell::bounds::Rect;
use memry_desktop::shell::caption::{CaptionButton, CaptionRects};
use memry_desktop::shell::nav_input::app_command_direction;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    IsZoomed, PostMessageW, SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE, WM_APPCOMMAND, WM_SIZE,
    WM_SYSCOMMAND,
};

use super::MAIN_LABEL;
use crate::events::{
    AppNavigationRequestedEvent, WindowCaptionHoverChangedEvent, WindowCaptionPressedChangedEvent,
    send_to,
};

const SUBCLASS_ID: usize = 0x4D45_4D52;
const WM_NCMOUSELEAVE: u32 = 0x02A2;

/// State the window procedures read. Leaked on purpose: the main window lives as long as the
/// process, and a procedure may run until the window is destroyed.
struct Shared {
    rects: ArcSwap<CaptionRects>,
    hover: AtomicU8,
    pressed: AtomicU8,
    tracking: AtomicBool,
    /// The main window and the input sink, as raw handles (`HWND` is not `Sync`).
    parent: AtomicIsize,
    sink: AtomicIsize,
    app: AppHandle<Wry>,
}

pub struct CaptionHandle(&'static Shared);

fn encode(button: Option<CaptionButton>) -> u8 {
    match button {
        None => 0,
        Some(CaptionButton::Minimize) => 1,
        Some(CaptionButton::Maximize) => 2,
        Some(CaptionButton::Close) => 3,
    }
}

fn decode(value: u8) -> Option<CaptionButton> {
    match value {
        1 => Some(CaptionButton::Minimize),
        2 => Some(CaptionButton::Maximize),
        3 => Some(CaptionButton::Close),
        _ => None,
    }
}

impl Shared {
    fn set_hover(&self, button: Option<CaptionButton>) {
        if self.hover.swap(encode(button), Ordering::Relaxed) != encode(button) {
            send_to(
                &self.app,
                MAIN_LABEL,
                WindowCaptionHoverChangedEvent {
                    button: button.map(|b| b.name().to_owned()),
                },
            );
        }
    }

    fn set_pressed(&self, button: Option<CaptionButton>) -> Option<CaptionButton> {
        let before = decode(self.pressed.swap(encode(button), Ordering::Relaxed));
        if before != button {
            send_to(
                &self.app,
                MAIN_LABEL,
                WindowCaptionPressedChangedEvent {
                    button: button.map(|b| b.name().to_owned()),
                },
            );
        }
        before
    }
}

fn client_point(window: HWND, x: i32, y: i32) -> Option<(i32, i32)> {
    let mut p = POINT { x, y };
    // SAFETY: `window` is a live window of this thread.
    unsafe { ScreenToClient(window, &mut p) }
        .as_bool()
        .then_some((p.x, p.y))
}

unsafe extern "system" fn top_level_proc(
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
        // Maximize and restore move the top edge in and out of the resize border.
        WM_SIZE => sink::place(shared),
        WM_APPCOMMAND => {
            // GET_APPCOMMAND_LPARAM: the high word without the device bits.
            let command = ((lparam.0 >> 16) & 0x0FFF) as i32;
            if let Some(direction) = app_command_direction(command) {
                send_to(
                    &shared.app,
                    MAIN_LABEL,
                    AppNavigationRequestedEvent {
                        direction: direction.name().to_owned(),
                    },
                );
                return LRESULT(1);
            }
        }
        _ => {}
    }
    // SAFETY: forwards the message this procedure received.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

fn system_command(hwnd: HWND, button: CaptionButton) {
    let command = match button {
        CaptionButton::Minimize => SC_MINIMIZE,
        CaptionButton::Maximize => {
            // SAFETY: `hwnd` is the live main window.
            if unsafe { IsZoomed(hwnd) }.as_bool() {
                SC_RESTORE
            } else {
                SC_MAXIMIZE
            }
        }
        CaptionButton::Close => SC_CLOSE,
    };
    // SAFETY: posting a system command to the live main window.
    if let Err(error) = unsafe {
        PostMessageW(
            Some(hwnd),
            WM_SYSCOMMAND,
            WPARAM(command as usize),
            LPARAM(0),
        )
    } {
        tracing::warn!(scope = "Window", "caption command was not posted: {error}");
    }
}

/// Subclasses the main window and creates the input sink. Runs on the thread that owns it,
/// after the webview was built, so the sink starts above the WebView2 windows.
pub fn install(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    let Ok(hwnd) = window.hwnd() else {
        tracing::warn!(
            scope = "Window",
            "no window handle; caption buttons stay inert"
        );
        return;
    };
    let shared: &'static Shared = Box::leak(Box::new(Shared {
        rects: ArcSwap::from_pointee(CaptionRects::default()),
        hover: AtomicU8::new(0),
        pressed: AtomicU8::new(0),
        tracking: AtomicBool::new(false),
        parent: AtomicIsize::new(hwnd.0 as isize),
        sink: AtomicIsize::new(0),
        app: app.clone(),
    }));
    match sink::create(hwnd, shared) {
        Some(sink) => shared.sink.store(sink.0 as isize, Ordering::Relaxed),
        None => tracing::warn!(
            scope = "Window",
            "the caption input sink was not created; caption buttons stay inert"
        ),
    }
    // SAFETY: the procedure and its refdata outlive the window.
    let ok = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(top_level_proc),
            SUBCLASS_ID,
            shared as *const _ as usize,
        )
    };
    if !ok.as_bool() {
        tracing::warn!(scope = "Window", "the caption subclass was not installed");
    }
    app.manage(CaptionHandle(shared));
}

/// Puts the input sink back above the WebView2 windows once the page has loaded, in case the
/// webview added a window after the sink.
pub fn raise(app: &AppHandle<Wry>) {
    if let Some(handle) = app.try_state::<CaptionHandle>() {
        sink::raise(handle.0);
    }
}

/// Stores the rectangles the page measured and moves the input sink over them.
pub fn set_rects(app: &AppHandle<Wry>, rects: CaptionRects) {
    let Some(handle) = app.try_state::<CaptionHandle>() else {
        return;
    };
    let shared = handle.0;
    shared.rects.store(Arc::new(rects));
    if let Err(error) = app.run_on_main_thread(move || sink::place(shared)) {
        tracing::warn!(scope = "Window", "caption input sink not moved: {error}");
    }
}

pub fn to_rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x: x.round() as i32,
        y: y.round() as i32,
        width: width.round() as i32,
        height: height.round() as i32,
    }
}

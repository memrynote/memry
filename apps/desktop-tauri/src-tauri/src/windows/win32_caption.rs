//! Native hit testing for the React caption buttons (Windows). The page draws minimize,
//! maximize and close and reports their rectangles; two window subclasses answer the native
//! messages from those rectangles:
//!
//! - the top-level window returns `HTMINBUTTON`, `HTMAXBUTTON` or `HTCLOSE` for `WM_NCHITTEST`
//!   inside a rectangle, so Windows 11 shows its snap-layout flyout over maximize and the
//!   buttons act through `WM_SYSCOMMAND`. The page gets no mouse events for them, so hover and
//!   press travel as events. `WM_APPCOMMAND` carries the browser back and forward keys.
//! - the WebView2 render child returns `HTTRANSPARENT` inside the rectangles, so the hit test
//!   falls through to the parent.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use arc_swap::ArcSwap;
use memry_desktop::shell::bounds::Rect;
use memry_desktop::shell::caption::{CaptionButton, CaptionRects};
use memry_desktop::shell::nav_input::app_command_direction;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetParent, IsZoomed, PostMessageW, SC_CLOSE, SC_MAXIMIZE,
    SC_MINIMIZE, SC_RESTORE, WM_APPCOMMAND, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
    WM_NCMOUSEMOVE, WM_SYSCOMMAND,
};
use windows::core::BOOL;

use super::MAIN_LABEL;
use crate::events::{
    AppNavigationRequestedEvent, WindowCaptionHoverChangedEvent, WindowCaptionPressedChangedEvent,
    send_to,
};

const SUBCLASS_ID: usize = 0x4D45_4D52;
const WM_NCMOUSELEAVE: u32 = 0x02A2;
const HTTRANSPARENT: isize = -1;
const RENDER_WIDGET_CLASS: &str = "Chrome_RenderWidgetHostHWND";
const CHILD_RETRIES: u32 = 10;
const CHILD_RETRY_MS: u64 = 200;

/// State the window procedures read. Leaked on purpose: the main window lives as long as the
/// process, and a procedure may run until the window is destroyed.
struct Shared {
    rects: ArcSwap<CaptionRects>,
    hover: AtomicU8,
    pressed: AtomicU8,
    tracking: AtomicBool,
    child_installed: AtomicBool,
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

fn point(lparam: LPARAM) -> (i32, i32) {
    // GET_X_LPARAM and GET_Y_LPARAM: signed 16-bit halves, screen coordinates.
    (
        i32::from((lparam.0 & 0xFFFF) as u16 as i16),
        i32::from(((lparam.0 >> 16) & 0xFFFF) as u16 as i16),
    )
}

fn client_point(window: HWND, lparam: LPARAM) -> Option<(i32, i32)> {
    let (x, y) = point(lparam);
    let mut p = POINT { x, y };
    // SAFETY: `window` is the live window the message was sent to.
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
        WM_NCHITTEST => {
            if let Some((x, y)) = client_point(hwnd, lparam)
                && let Some(button) = shared.rects.load().hit(x, y)
            {
                return LRESULT(button.hit_code());
            }
        }
        WM_NCLBUTTONDOWN => {
            if let Some(button) = CaptionButton::from_hit_code(wparam.0 as isize) {
                shared.set_pressed(Some(button));
                return LRESULT(0);
            }
        }
        WM_NCLBUTTONUP => {
            if let Some(button) = CaptionButton::from_hit_code(wparam.0 as isize) {
                if shared.set_pressed(None) == Some(button) {
                    system_command(hwnd, button);
                }
                return LRESULT(0);
            }
        }
        WM_NCMOUSEMOVE => {
            let button = CaptionButton::from_hit_code(wparam.0 as isize);
            shared.set_hover(button);
            if button.is_some() && !shared.tracking.swap(true, Ordering::Relaxed) {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                // SAFETY: `track` is a valid, initialized structure for the call.
                if unsafe { TrackMouseEvent(&mut track) }.is_err() {
                    shared.tracking.store(false, Ordering::Relaxed);
                }
            }
        }
        WM_NCMOUSELEAVE => {
            shared.tracking.store(false, Ordering::Relaxed);
            shared.set_hover(None);
            shared.set_pressed(None);
        }
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

unsafe extern "system" fn render_child_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    refdata: usize,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        // SAFETY: `refdata` is the leaked `Shared` installed with this subclass.
        let shared = unsafe { &*(refdata as *const Shared) };
        // SAFETY: `hwnd` is the live child this procedure is installed on.
        let parent = unsafe { GetParent(hwnd) }.unwrap_or(hwnd);
        if let Some((x, y)) = client_point(parent, lparam)
            && shared.rects.load().hit(x, y).is_some()
        {
            return LRESULT(HTTRANSPARENT);
        }
    }
    // SAFETY: forwards the message this procedure received.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Subclasses the main window. Runs on the thread that owns it.
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
        child_installed: AtomicBool::new(false),
        app: app.clone(),
    }));
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

unsafe extern "system" fn find_render_child(child: HWND, lparam: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    // SAFETY: `child` was handed out by the enumeration.
    let length = unsafe { GetClassNameW(child, &mut name) };
    let class = String::from_utf16_lossy(&name[..usize::try_from(length).unwrap_or(0)]);
    if class == RENDER_WIDGET_CLASS {
        // SAFETY: `lparam` is the `Option<HWND>` slot `install_child` passed.
        unsafe { *(lparam.0 as *mut Option<HWND>) = Some(child) };
        return BOOL(0);
    }
    BOOL(1)
}

fn try_install_child(window: &WebviewWindow<Wry>, shared: &'static Shared) -> bool {
    let Ok(top) = window.hwnd() else { return true };
    let mut found: Option<HWND> = None;
    // SAFETY: the callback only writes the slot passed through `lparam`, which outlives it.
    let _ = unsafe {
        EnumChildWindows(
            Some(top),
            Some(find_render_child),
            LPARAM(&mut found as *mut _ as isize),
        )
    };
    let Some(child) = found else { return false };
    // SAFETY: the procedure and its refdata outlive the window.
    unsafe {
        SetWindowSubclass(
            child,
            Some(render_child_proc),
            SUBCLASS_ID,
            shared as *const _ as usize,
        )
    }
    .as_bool()
}

/// Subclasses the WebView2 render child once it exists (after the first navigation commits):
/// retries every 200 ms, up to ten times.
pub fn install_child(app: &AppHandle<Wry>) {
    let Some(handle) = app.try_state::<CaptionHandle>() else {
        return;
    };
    let shared = handle.0;
    if shared.child_installed.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..CHILD_RETRIES {
            let (tx, rx) = std::sync::mpsc::channel();
            let for_main = app.clone();
            let queued = app.run_on_main_thread(move || {
                let done = for_main
                    .get_webview_window(MAIN_LABEL)
                    .is_none_or(|window| try_install_child(&window, shared));
                let _ = tx.send(done);
            });
            if queued.is_ok() && rx.recv().unwrap_or(true) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(CHILD_RETRY_MS)).await;
        }
        tracing::warn!(
            scope = "Window",
            "the render child was not found; snap layouts are off"
        );
        shared.child_installed.store(false, Ordering::SeqCst);
    });
}

pub fn set_rects(app: &AppHandle<Wry>, rects: CaptionRects) {
    if let Some(handle) = app.try_state::<CaptionHandle>() {
        handle.0.rects.store(Arc::new(rects));
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

//! The input sink: a child window of ours over the three caption buttons. It is above the
//! WebView2 windows, so it gets the hit test there and answers `HTMINBUTTON`, `HTMAXBUTTON` or
//! `HTCLOSE`. It paints nothing and has no background brush, so the page shows through, as with
//! the resize-border child Tauri places over the webview of an undecorated window
//! (`tauri-runtime-wry` `undecorated_resizing.rs`).

use std::sync::atomic::Ordering;

use memry_desktop::shell::caption::CaptionButton;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, ValidateRect};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CREATESTRUCTW, CreateWindowExW, DefWindowProcW, GWLP_USERDATA, GetWindowLongPtrW, HTCLIENT,
    HWND_TOP, IDC_ARROW, IsZoomed, LoadCursorW, MA_NOACTIVATE, RegisterClassW, SM_CYFRAME, SW_HIDE,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos,
    ShowWindow, WINDOW_EX_STYLE, WM_CAPTURECHANGED, WM_ERASEBKGND, WM_LBUTTONUP, WM_MOUSEACTIVATE,
    WM_NCCREATE, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCMOUSEMOVE, WM_PAINT,
    WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS,
};
use windows::core::w;

use super::{Shared, WM_NCMOUSELEAVE, client_point, system_command};

fn handle(raw: &std::sync::atomic::AtomicIsize) -> HWND {
    HWND(raw.load(Ordering::Relaxed) as *mut _)
}

/// The signed 16-bit halves of a mouse message's `lParam` (`GET_X_LPARAM`, `GET_Y_LPARAM`).
fn lparam_point(lparam: LPARAM) -> (i32, i32) {
    (
        i32::from((lparam.0 & 0xFFFF) as u16 as i16),
        i32::from(((lparam.0 >> 16) & 0xFFFF) as u16 as i16),
    )
}

/// Creates the sink as a hidden child of `parent`. Runs on the thread that owns `parent`.
pub(super) fn create(parent: HWND, shared: &'static Shared) -> Option<HWND> {
    // SAFETY: window-class and window creation on the UI thread; `shared` is leaked, so the
    // pointer in the creation parameters outlives the window.
    unsafe {
        let instance = GetModuleHandleW(None).ok()?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(sink_proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).ok()?,
            lpszClassName: w!("MemryCaptionInputSink"),
            ..Default::default()
        };
        // A second registration in the process fails with "already exists", which is harmless.
        RegisterClassW(&class);
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("MemryCaptionInputSink"),
            w!(""),
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            Some(parent),
            None,
            Some(instance.into()),
            Some(shared as *const Shared as *const _),
        )
        .ok()
    }
}

/// Moves the sink over the buttons and above the webview, or hides it while there are none.
/// Runs on the UI thread.
pub(super) fn place(shared: &Shared) {
    let (parent, sink) = (handle(&shared.parent), handle(&shared.sink));
    if sink.0.is_null() {
        return;
    }
    // SAFETY: `parent` and `sink` are live windows of this thread.
    unsafe {
        let border = if IsZoomed(parent).as_bool() {
            0
        } else {
            GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(parent))
        };
        let Some(bounds) = shared.rects.load().sink_bounds(border) else {
            let _ = ShowWindow(sink, SW_HIDE);
            return;
        };
        if let Err(error) = SetWindowPos(
            sink,
            Some(HWND_TOP),
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        ) {
            tracing::warn!(scope = "Window", "caption input sink not placed: {error}");
        }
    }
}

/// Puts the sink back above the WebView2 windows, which may have been added after it.
pub(super) fn raise(shared: &Shared) {
    let sink = handle(&shared.sink);
    if sink.0.is_null() {
        return;
    }
    // SAFETY: `sink` is a live window of this thread.
    let _ = unsafe {
        SetWindowPos(
            sink,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
}

/// The button under a point given in the sink's client coordinates.
fn button_at(shared: &Shared, sink: HWND, x: i32, y: i32) -> Option<CaptionButton> {
    let mut screen = POINT { x, y };
    // SAFETY: `sink` is the live window the message was sent to.
    if !unsafe { ClientToScreen(sink, &mut screen) }.as_bool() {
        return None;
    }
    let (px, py) = client_point(handle(&shared.parent), screen.x, screen.y)?;
    shared.rects.load().hit(px, py)
}

fn track_leave(shared: &Shared, sink: HWND) {
    if shared.tracking.swap(true, Ordering::Relaxed) {
        return;
    }
    let mut track = TRACKMOUSEEVENT {
        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE | TME_NONCLIENT,
        hwndTrack: sink,
        dwHoverTime: 0,
    };
    // SAFETY: `track` is a valid, initialized structure for the call.
    if unsafe { TrackMouseEvent(&mut track) }.is_err() {
        shared.tracking.store(false, Ordering::Relaxed);
    }
}

unsafe extern "system" fn sink_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCCREATE {
        // SAFETY: `lparam` points at the `CREATESTRUCTW` of this message.
        let create = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
        // SAFETY: stores the leaked `Shared` passed to `CreateWindowExW`.
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize) };
    }
    // SAFETY: the pointer is the leaked `Shared` stored above, or null before `WM_NCCREATE`.
    let shared = unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Shared).as_ref() };
    let Some(shared) = shared else {
        // SAFETY: forwards the message this procedure received.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    };
    match msg {
        WM_NCHITTEST => {
            let (x, y) = lparam_point(lparam);
            let hit = client_point(handle(&shared.parent), x, y)
                .and_then(|(x, y)| shared.rects.load().hit(x, y));
            return LRESULT(hit.map_or(HTCLIENT as isize, CaptionButton::hit_code));
        }
        WM_NCMOUSEMOVE => {
            let button = CaptionButton::from_hit_code(wparam.0 as isize);
            shared.set_hover(button);
            if button.is_some() {
                track_leave(shared, hwnd);
            }
            return LRESULT(0);
        }
        WM_NCMOUSELEAVE => {
            shared.tracking.store(false, Ordering::Relaxed);
            shared.set_hover(None);
            return LRESULT(0);
        }
        // The second click of a double click is a press too, as on a native caption button.
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
            if let Some(button) = CaptionButton::from_hit_code(wparam.0 as isize) {
                shared.set_pressed(Some(button));
                // The release may happen off the button; the capture delivers it either way,
                // as a client-area message.
                // SAFETY: `hwnd` is the live sink.
                unsafe { SetCapture(hwnd) };
                return LRESULT(0);
            }
        }
        WM_LBUTTONUP => {
            let (x, y) = lparam_point(lparam);
            let released_on = button_at(shared, hwnd, x, y);
            let pressed = shared.set_pressed(None);
            // SAFETY: releases the capture taken on the press.
            let _ = unsafe { ReleaseCapture() };
            if let Some(button) = pressed
                && released_on == Some(button)
            {
                system_command(handle(&shared.parent), button);
            }
            return LRESULT(0);
        }
        WM_CAPTURECHANGED => {
            shared.set_pressed(None);
        }
        // A click on a button must not move keyboard focus out of the editor.
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => return LRESULT(1),
        WM_PAINT => {
            // SAFETY: validates the whole client area of the live window; nothing is drawn.
            let _ = unsafe { ValidateRect(Some(hwnd), None) };
            return LRESULT(0);
        }
        _ => {}
    }
    // SAFETY: forwards the message this procedure received.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

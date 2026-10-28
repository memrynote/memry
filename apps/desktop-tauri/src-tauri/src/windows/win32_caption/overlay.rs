//! The window that owns the caption buttons' hit testing.
//!
//! WebView2's render widget belongs to another process (`msedgewebview2.exe`), so it cannot be
//! subclassed, and it answers `WM_NCHITTEST` with `HTCLIENT` over the whole page: the top-level
//! window never sees the mouse over the React buttons. A child window of ours placed over them is
//! the topmost window there, so it gets the hit test, answers `HTMINBUTTON`, `HTMAXBUTTON` or
//! `HTCLOSE`, and Windows 11 shows its snap-layout flyout over the maximize button. The overlay
//! draws nothing; the page draws the buttons and reports where they are.

use std::sync::atomic::Ordering;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, ValidateRect};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GWLP_USERDATA, GetParent, GetWindowLongPtrW, HTCLIENT,
    HWND_TOP, IDC_ARROW, IsZoomed, LWA_ALPHA, LoadCursorW, RegisterClassW, SM_CYFRAME,
    SW_HIDE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetLayeredWindowAttributes,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, WM_CAPTURECHANGED, WM_ERASEBKGND, WM_LBUTTONUP,
    WM_MOUSEACTIVATE, WM_NCCREATE, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCMOUSEMOVE, WM_PAINT,
    WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_EX_NOREDIRECTIONBITMAP, WS_VISIBLE,
    CREATESTRUCTW,
};
use windows::core::w;

use super::{Shared, WM_NCMOUSELEAVE, client_point, system_command};
use memry_desktop::shell::caption::CaptionButton;

const MA_NOACTIVATE: isize = 3;

/// Creates the overlay as a child of `parent`, hidden until the page reports the buttons.
/// Runs on the thread that owns `parent`.
pub(super) fn create(parent: HWND, shared: &'static Shared) -> Option<HWND> {
    // SAFETY: plain window-class and window creation on the UI thread; `shared` is leaked, so the
    // pointer in the creation parameters outlives the window.
    unsafe {
        let instance = GetModuleHandleW(None).ok()?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(overlay_proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).ok()?,
            lpszClassName: w!("MemryCaptionOverlay"),
            ..Default::default()
        };
        // A second registration (a second window) fails with a harmless "already exists".
        RegisterClassW(&class);
        let layered = std::env::var("MEMRY_CAPTION_OVERLAY").as_deref() != Ok("plain");
        let ex_style = if layered {
            WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP
        } else {
            Default::default()
        };
        let window = CreateWindowExW(
            ex_style,
            w!("MemryCaptionOverlay"),
            w!(""),
            WS_CHILD | WS_CLIPSIBLINGS | WS_VISIBLE,
            0,
            0,
            0,
            0,
            Some(parent),
            None,
            Some(instance.into()),
            Some(shared as *const Shared as *const _),
        )
        .ok()?;
        if layered {
            // Fully opaque, so it takes the mouse; it draws nothing, so the page shows through.
            let _ = SetLayeredWindowAttributes(window, COLORREF(0), 255, LWA_ALPHA);
        }
        let _ = ShowWindow(window, SW_HIDE);
        Some(window)
    }
}

/// Moves the overlay over the three buttons, or hides it while there are none. Runs on the UI
/// thread. The top of a restored window is left to the resize border.
pub(super) fn place(shared: &Shared) {
    let (parent, overlay) = (
        HWND(shared.parent.load(Ordering::Relaxed) as *mut _),
        HWND(shared.overlay.load(Ordering::Relaxed) as *mut _),
    );
    if overlay.0.is_null() {
        return;
    }
    let rects = shared.rects.load();
    let boxes = [rects.minimize, rects.maximize, rects.close];
    let present = || boxes.iter().flatten();
    let left = present().map(|r| r.x).min();
    let top = present().map(|r| r.y).min();
    let right = present().map(|r| r.x + r.width).max();
    let bottom = present().map(|r| r.y + r.height).max();
    // SAFETY: `parent` and `overlay` are live windows of this thread.
    unsafe {
        let (Some(left), Some(top), Some(right), Some(bottom)) = (left, top, right, bottom) else {
            let _ = ShowWindow(overlay, SW_HIDE);
            return;
        };
        let border = if IsZoomed(parent).as_bool() {
            0
        } else {
            GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(parent))
        };
        let top = top.max(border);
        if right <= left || bottom <= top {
            let _ = ShowWindow(overlay, SW_HIDE);
            return;
        }
        let _ = SetWindowPos(
            overlay,
            Some(HWND_TOP),
            left,
            top,
            right - left,
            bottom - top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

/// Puts the overlay back above the WebView2 windows, which may have been added after it.
pub(super) fn raise(shared: &Shared) {
    let overlay = HWND(shared.overlay.load(Ordering::Relaxed) as *mut _);
    if overlay.0.is_null() {
        return;
    }
    // SAFETY: `overlay` is a live window of this thread.
    let _ = unsafe {
        SetWindowPos(
            overlay,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
}

/// The button under the point (client coordinates of the overlay) in the rectangles the page
/// reported, which are in the main window's client coordinates.
fn button_at(shared: &Shared, overlay: HWND, x: i32, y: i32) -> Option<CaptionButton> {
    let mut screen = windows::Win32::Foundation::POINT { x, y };
    // SAFETY: `overlay` is the live window the message was sent to.
    if !unsafe { ClientToScreen(overlay, &mut screen) }.as_bool() {
        return None;
    }
    // SAFETY: as above.
    let parent = unsafe { GetParent(overlay) }.ok()?;
    let lparam = LPARAM(((screen.y as isize & 0xFFFF) << 16) | (screen.x as isize & 0xFFFF));
    let (px, py) = client_point(parent, lparam)?;
    shared.rects.load().hit(px, py)
}

unsafe extern "system" fn overlay_proc(
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
            let hit = parent_point(hwnd, lparam).and_then(|(x, y)| shared.rects.load().hit(x, y));
            return LRESULT(hit.map_or(HTCLIENT as isize, CaptionButton::hit_code));
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
            return LRESULT(0);
        }
        WM_NCMOUSELEAVE => {
            shared.tracking.store(false, Ordering::Relaxed);
            shared.set_hover(None);
            return LRESULT(0);
        }
        WM_NCLBUTTONDOWN => {
            if let Some(button) = CaptionButton::from_hit_code(wparam.0 as isize) {
                shared.set_pressed(Some(button));
                // The release may happen off the button; capture delivers it either way, as a
                // client-area message.
                // SAFETY: `hwnd` is the live overlay.
                unsafe { SetCapture(hwnd) };
                return LRESULT(0);
            }
        }
        WM_LBUTTONUP => {
            let x = i32::from((lparam.0 & 0xFFFF) as u16 as i16);
            let y = i32::from(((lparam.0 >> 16) & 0xFFFF) as u16 as i16);
            let released_on = button_at(shared, hwnd, x, y);
            let pressed = shared.set_pressed(None);
            // SAFETY: releases the capture taken on the press.
            let _ = unsafe { ReleaseCapture() };
            if let Some(button) = pressed
                && released_on == Some(button)
                && let Ok(top) = unsafe { GetParent(hwnd) }
            {
                system_command(top, button);
            }
            return LRESULT(0);
        }
        WM_CAPTURECHANGED => {
            shared.set_pressed(None);
        }
        // The page's own click must not move keyboard focus out of the editor.
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE),
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

/// `lparam` of a hit test (screen coordinates) in the parent's client coordinates.
fn parent_point(overlay: HWND, lparam: LPARAM) -> Option<(i32, i32)> {
    // SAFETY: `overlay` is the live window the message was sent to.
    let parent = unsafe { GetParent(overlay) }.ok()?;
    client_point(parent, lparam)
}

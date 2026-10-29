use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime};

use crate::commands::error::{CommandError, ErrorKind};

const MAIN_THREAD_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eWindow {
    pub label: String,
    pub visible: bool,
    pub focused: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn failure(error: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Internal, "e2e_window", error.to_string())
}

/// Position and inner size in logical pixels.
#[tauri::command]
pub fn e2e_windows<R: Runtime>(app: AppHandle<R>) -> Result<Vec<E2eWindow>, CommandError> {
    let mut windows = Vec::new();
    for (label, window) in app.webview_windows() {
        let scale = window.scale_factor().map_err(failure)?;
        let position = window
            .outer_position()
            .map_err(failure)?
            .to_logical::<f64>(scale);
        let size = window
            .inner_size()
            .map_err(failure)?
            .to_logical::<f64>(scale);
        windows.push(E2eWindow {
            visible: window.is_visible().map_err(failure)?,
            focused: window.is_focused().map_err(failure)?,
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            title: window.title().map_err(failure)?,
            label,
        });
    }
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(windows)
}

/// Restores the window, then moves it and sets its inner size, both in logical pixels, on the
/// main thread.
#[tauri::command]
pub async fn e2e_set_window_rect<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), CommandError> {
    let window = app.get_webview_window(&label).ok_or_else(|| {
        CommandError::new(
            ErrorKind::NotFound,
            "e2e_window",
            format!("no window {label}"),
        )
    })?;
    let (done, result) = mpsc::channel();
    app.run_on_main_thread(move || {
        // A window manager that maximizes a window larger than the screen (XFCE on a small
        // display) ignores `set_size` until the window is restored.
        let applied = window
            .unmaximize()
            .and_then(|()| window.set_size(LogicalSize::new(width, height)))
            .and_then(|()| window.set_position(LogicalPosition::new(x, y)));
        // The receiver outlives the call unless it timed out, in which case nobody reads it.
        let _ = done.send(applied.map_err(|error| error.to_string()));
    })
    .map_err(failure)?;
    tauri::async_runtime::spawn_blocking(move || result.recv_timeout(MAIN_THREAD_WAIT))
        .await
        .map_err(failure)?
        .map_err(failure)?
        .map_err(failure)
}

/// The main window's close, minimize and zoom buttons, in points from the window's top-left
/// corner. Empty off macOS.
#[tauri::command]
pub async fn e2e_traffic_lights(app: AppHandle<tauri::Wry>) -> Result<Vec<E2eRect>, CommandError> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window(crate::windows::MAIN_LABEL)
            .ok_or_else(|| {
                CommandError::new(ErrorKind::NotFound, "e2e_window", "no main window")
            })?;
        let (done, result) = mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = done.send(traffic_light_rects(&window));
        })
        .map_err(failure)?;
        tauri::async_runtime::spawn_blocking(move || result.recv_timeout(MAIN_THREAD_WAIT))
            .await
            .map_err(failure)?
            .map_err(failure)?
            .map_err(failure)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
fn traffic_light_rects(window: &tauri::WebviewWindow<tauri::Wry>) -> Result<Vec<E2eRect>, String> {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri hands out the live NSWindow of the window, and this runs on the main thread.
    let ns_window = unsafe { &*pointer.cast::<NSWindow>() };
    let window_height = ns_window.frame().size.height;
    [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .map(|kind| {
        let button = ns_window
            .standardWindowButton(kind)
            .ok_or("the window has no traffic lights")?;
        // Window coordinates start at the bottom-left corner of the frame.
        let rect = button.convertRect_toView(button.bounds(), None);
        Ok(E2eRect {
            x: rect.origin.x,
            y: window_height - rect.origin.y - rect.size.height,
            width: rect.size.width,
            height: rect.size.height,
        })
    })
    .collect()
}

/// Posts the `WM_SYSCOMMAND` `SC_KEYMENU` a bare Alt sends the main window, and reports whether
/// its thread went into menu mode within 2 s (then ends that mode). Always false off Windows.
#[tauri::command]
pub async fn e2e_bare_alt_menu_mode(app: AppHandle<tauri::Wry>) -> Result<bool, CommandError> {
    #[cfg(windows)]
    {
        let window = app
            .get_webview_window(crate::windows::MAIN_LABEL)
            .ok_or_else(|| {
                CommandError::new(ErrorKind::NotFound, "e2e_window", "no main window")
            })?;
        // `HWND` is not `Send`: the raw handle crosses into the blocking task.
        let raw = window.hwnd().map_err(failure)?.0 as isize;
        tauri::async_runtime::spawn_blocking(move || key_menu_mode(raw))
            .await
            .map_err(failure)?
            .map_err(failure)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(false)
    }
}

#[cfg(windows)]
fn key_menu_mode(raw: isize) -> windows::core::Result<bool> {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GUI_INMENUMODE, GUITHREADINFO, GetGUIThreadInfo, GetWindowThreadProcessId, PostMessageW,
        SC_KEYMENU, WM_CANCELMODE, WM_SYSCOMMAND,
    };

    let hwnd = HWND(raw as *mut _);
    // SAFETY: the main window lives as long as the app; posting and reading its thread's GUI
    // state are safe from any thread.
    unsafe {
        let thread = GetWindowThreadProcessId(hwnd, None);
        if thread == 0 {
            return Err(windows::core::Error::from_thread());
        }
        PostMessageW(
            Some(hwnd),
            WM_SYSCOMMAND,
            WPARAM(SC_KEYMENU as usize),
            LPARAM(0),
        )?;
        // A busy main thread takes the message late, so the mode is polled, not read once.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let mut info = GUITHREADINFO {
                cbSize: size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            GetGUIThreadInfo(thread, &mut info)?;
            if info.flags.0 & GUI_INMENUMODE.0 != 0 {
                PostMessageW(Some(hwnd), WM_CANCELMODE, WPARAM(0), LPARAM(0))?;
                return Ok(true);
            }
            if std::time::Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

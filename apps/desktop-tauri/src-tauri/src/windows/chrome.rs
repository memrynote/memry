//! The frame of the main window per OS.
//!
//! - macOS: hidden title bar with the close button's frame at (12, 12), as in Electron, drawn
//!   over the title row.
//! - Windows: no native frame. The caption buttons are a React component answered by
//!   `win32_caption`, and the window keeps its shadow and resize borders.
//! - Linux: the native frame.

use tauri::{Runtime, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
pub fn apply<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // Electron put the close button's frame at (12, 12). Tauri's `y` is not that offset: the
        // title bar container becomes `button height + y` tall and AppKit keeps the buttons 9
        // points above its bottom, so the frame's top lands at `y - 9`
        // (`e2e/specs/shell/traffic-lights.e2e.ts`).
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 21.0))
}

#[cfg(windows)]
pub fn apply<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder.decorations(false).shadow(true).resizable(true)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn apply<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}

/// WebView2 browser shortcuts (F5, Ctrl+P, Ctrl+F, F12, Ctrl+Shift+I) would act on their own;
/// the menu items and the editor own those keys.
#[cfg(windows)]
pub fn disable_browser_accelerators(window: &tauri::WebviewWindow<tauri::Wry>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let result = window.with_webview(|webview| {
        // SAFETY: the controller is alive for the closure, which runs on the UI thread.
        let outcome = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false))
        };
        if let Err(error) = outcome {
            tracing::warn!(
                scope = "Window",
                "browser accelerator keys stay on: {error}"
            );
        }
    });
    if let Err(error) = result {
        tracing::warn!(
            scope = "Window",
            "webview settings were not reached: {error}"
        );
    }
}

//! Prints a loaded webview to a PDF file through the OS engine, with the page settings of
//! Electron's `printToPDF` call (`ipc/notes-handlers.ts:1022-1031`): the page size asked for,
//! 0.5 inch margins, backgrounds, portrait, scale 1, no header or footer. The platform files are
//! the only unsafe code of the export.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::path::Path;

use tauri::webview::PlatformWebview;
use tokio::sync::oneshot;

/// Each margin, as Electron's `margins: { top: 0.5, ... }` (inches).
pub const MARGIN_INCHES: f64 = 0.5;

/// The `pageSize` values Electron's export offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paper {
    A4,
    Letter,
    Legal,
}

impl Paper {
    /// Width and height in points (1/72 inch), portrait.
    pub fn points(self) -> (f64, f64) {
        match self {
            Self::A4 => (595.28, 841.89),
            Self::Letter => (612.0, 792.0),
            Self::Legal => (612.0, 1008.0),
        }
    }

    /// Width and height in inches, portrait.
    pub fn inches(self) -> (f64, f64) {
        let (width, height) = self.points();
        (width / 72.0, height / 72.0)
    }

    /// The PWG name GTK knows the size by.
    pub fn pwg_name(self) -> &'static str {
        match self {
            Self::A4 => "iso_a4",
            Self::Letter => "na_letter",
            Self::Legal => "na_legal",
        }
    }
}

/// Answered once, when the engine has written the file or failed (the engine's error text).
pub type Done = oneshot::Sender<Result<(), String>>;

/// Readies the hidden print window before its page loads: on macOS it is ordered in far off
/// screen, ignoring the mouse and never focused, because WKWebView lays out and prints nothing in
/// a window that is not on screen. Runs on the main thread (`with_webview`).
pub fn prepare(webview: &PlatformWebview) {
    #[cfg(target_os = "macos")]
    macos::prepare(webview);
    #[cfg(not(target_os = "macos"))]
    let _ = webview;
}

/// Starts printing `webview` to `target` and answers `done` when the engine is finished. Runs on
/// the main thread (`with_webview`).
pub fn start(webview: &PlatformWebview, paper: Paper, target: &Path, done: Done) {
    #[cfg(target_os = "macos")]
    macos::start(webview, paper, target, done);
    #[cfg(windows)]
    windows::start(webview, paper, target, done);
    #[cfg(target_os = "linux")]
    linux::start(webview, paper, target, done);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_sizes_are_electrons_in_points_and_inches() {
        assert_eq!(Paper::Letter.inches(), (8.5, 11.0));
        assert_eq!(Paper::Legal.inches(), (8.5, 14.0));
        let (width, height) = Paper::A4.inches();
        assert!((width - 8.2678).abs() < 1e-3 && (height - 11.6929).abs() < 1e-3);
    }
}

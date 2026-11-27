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
use url::Url;

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

pub fn is_page(url: &Url, page: &Url) -> bool {
    url.scheme() == page.scheme() && url.host_str() == page.host_str() && url.path() == page.path()
}

/// Whether the print window may load `to`: its staged `page`, or the blank page it opens on.
/// A `<meta http-equiv="refresh">`, a link, a form or a frame in a note's raw HTML goes nowhere.
/// Every engine's navigation handler and WebView2's request and frame guards ask this.
pub fn may_load(to: &Url, page: &Url) -> bool {
    to.as_str() == "about:blank" || is_page(to, page)
}

/// Readies the hidden print window before its page loads. On macOS it is ordered in far off
/// screen, ignoring the mouse and never focused, because WKWebView lays out and prints nothing in
/// a window that is not on screen. On Windows every request and frame navigation [`may_load`]
/// refuses is stopped, since WebView2's top-level navigation handler alone let a meta refresh
/// reach the network. An error leaves the window unguarded, so the export fails. Runs on the main
/// thread (`with_webview`).
pub fn prepare(webview: &PlatformWebview, page: &Url) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    macos::prepare(webview);
    #[cfg(windows)]
    windows::guard(webview, page)?;
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = webview;
    #[cfg(not(windows))]
    let _ = page;
    Ok(())
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
    fn the_print_window_goes_only_to_its_page_or_blank() {
        let page = Url::parse("memry-export://localhost/7f1c.html").expect("url");
        let allowed = [
            page.as_str(),
            "about:blank",
            "memry-export://localhost/7f1c.html?x",
        ];
        for to in allowed {
            assert!(may_load(&Url::parse(to).expect("url"), &page), "{to}");
        }
        let denied = [
            "memry-export://localhost/8a2d.html",
            "https://memry-export.localhost/7f1c.html",
            "https://example.invalid/",
            "http://10.1.0.5:8080/refresh",
            "http://localhost/",
            "file:///etc/passwd",
            "data:text/html,<p>x</p>",
            "about:srcdoc",
            "about:blank#x",
            "memry-file://localhost/note.md",
            "memry-html://localhost/page.html",
        ];
        for to in denied {
            assert!(!may_load(&Url::parse(to).expect("url"), &page), "{to}");
        }
    }

    #[test]
    fn page_sizes_are_electrons_in_points_and_inches() {
        assert_eq!(Paper::Letter.inches(), (8.5, 11.0));
        assert_eq!(Paper::Legal.inches(), (8.5, 14.0));
        let (width, height) = Paper::A4.inches();
        assert!((width - 8.2678).abs() < 1e-3 && (height - 11.6929).abs() < 1e-3);
    }
}

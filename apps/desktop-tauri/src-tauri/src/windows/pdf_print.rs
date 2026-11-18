//! The hidden window the PDF export prints from: Electron's `notes:export-pdf` window
//! (`ipc/notes-handlers.ts:996-1037`), 800 by 600, never shown, script off, destroyed and its page
//! dropped in every outcome. It is made per export, never at startup.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

use super::main_window::webview_profile;
use super::registry::WindowKind;
use crate::protocols::export::Staged;
use crate::shell::navigation_guard;
use crate::shell::pdf::{self, Paper};

/// Load plus print; past it the export fails.
const DEADLINE: Duration = Duration::from_secs(30);

/// Electron's settle after `loadFile` (`ipc/notes-handlers.ts:1015`).
const SETTLE: Duration = Duration::from_millis(100);

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

/// Why no PDF came out; the text is the engine's or says which step failed.
#[derive(Debug)]
pub struct PdfError(pub String);

/// Destroys the print window when the export ends, whichever way.
struct Destroy(WebviewWindow<Wry>);

impl Drop for Destroy {
    fn drop(&mut self) {
        navigation_guard::exempt(&self.0, false);
        if let Err(error) = self.0.destroy() {
            tracing::warn!(
                scope = "Export",
                "the print window was not destroyed: {error}"
            );
        }
    }
}

/// Removes the engine's output file when the export ends, whichever way.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => tracing::warn!(
                scope = "Export",
                "the printed PDF was not removed from the temp dir: {error}"
            ),
        }
    }
}

/// `html` printed to PDF bytes with `paper`. The engine writes a temp file, so the target is
/// written only with a whole PDF, as Electron's `fs.writeFile(targetPath, pdfData)` is.
pub async fn print_to_pdf(
    app: &AppHandle<Wry>,
    html: String,
    paper: Paper,
) -> Result<Vec<u8>, PdfError> {
    let page = Staged::new(html);
    let output =
        TempFile(std::env::temp_dir().join(format!("memry-export-{}.pdf", Uuid::new_v4())));
    let (window, on_loaded) = open(app, &page)?;
    let window = Destroy(window);
    // The page loads once the window is exempt from the app's main-frame guard, which would
    // refuse it on macOS.
    navigation_guard::exempt(&window.0, true);
    window
        .0
        .with_webview(|webview| pdf::prepare(&webview))
        .map_err(|error| PdfError(format!("the print window is gone: {error}")))?;
    window
        .0
        .navigate(page.url())
        .map_err(|error| PdfError(format!("the print window did not load the page: {error}")))?;
    let printed = tokio::time::timeout(DEADLINE, async {
        on_loaded
            .await
            .map_err(|_| PdfError("the print window closed before the page loaded".into()))?;
        tokio::time::sleep(SETTLE).await;
        let (done, on_done) = oneshot::channel();
        let target = output.0.clone();
        window
            .0
            .with_webview(move |webview| pdf::start(&webview, paper, &target, done))
            .map_err(|error| PdfError(format!("the print window is gone: {error}")))?;
        on_done
            .await
            .map_err(|_| PdfError("the print engine never answered".into()))?
            .map_err(PdfError)
    })
    .await;
    match printed {
        Ok(result) => result?,
        Err(_) => return Err(PdfError("printing took longer than 30 seconds".into())),
    }
    read_pdf(&output.0)
}

/// The engine's file, refused unless it is a PDF.
fn read_pdf(path: &Path) -> Result<Vec<u8>, PdfError> {
    let bytes = std::fs::read(path)
        .map_err(|error| PdfError(format!("the printed PDF could not be read: {error}")))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err(PdfError("the print engine wrote no PDF".into()));
    }
    Ok(bytes)
}

fn is_page(url: &Url, page: &Url) -> bool {
    url.scheme() == page.scheme() && url.host_str() == page.host_str() && url.path() == page.path()
}

/// The print window over `page`, and the signal that its page finished loading.
fn open(
    app: &AppHandle<Wry>,
    page: &Staged,
) -> Result<(WebviewWindow<Wry>, oneshot::Receiver<()>), PdfError> {
    let (loaded, on_loaded) = oneshot::channel();
    let loaded = Mutex::new(Some(loaded));
    let label = WindowKind::PdfPrint.label(NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let url = page.url();
    let allowed = url.clone();
    let blank = Url::parse("about:blank").expect("about:blank parses");
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
        .title("MemryNote")
        .inner_size(800.0, 600.0)
        .visible(false)
        .focused(false)
        .focusable(false)
        .decorations(false)
        .skip_taskbar(true)
        .use_https_scheme(true)
        .disable_javascript()
        // The staged page only: a `<meta http-equiv="refresh">` in a note's raw HTML goes nowhere.
        .on_navigation(move |to| to.as_str() == "about:blank" || is_page(to, &allowed))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished
                && is_page(payload.url(), &url)
                && let Some(loaded) = loaded.lock().unwrap_or_else(PoisonError::into_inner).take()
            {
                let _ = loaded.send(());
            }
        });
    let window = webview_profile(builder, app)
        .build()
        .map_err(|error| PdfError(format!("the print window could not be opened: {error}")))?;
    Ok((window, on_loaded))
}

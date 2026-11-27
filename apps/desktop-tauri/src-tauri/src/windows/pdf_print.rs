//! The hidden window the PDF export prints from: Electron's `notes:export-pdf` window
//! (`ipc/notes-handlers.ts:996-1037`), 800 by 600, never shown, script off, destroyed and its page
//! dropped in every outcome. It is made per export, never at startup.
//!
//! The engine writes the PDF into [`PRINT_DIR`] of the app's data folder, private to the user,
//! never a shared temp dir: the file is the note in plain text until the export removes it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use memry_desktop::paths::AppPaths;
use tauri::async_runtime::JoinHandle;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

use super::main_window::webview_profile;
use super::registry::WindowKind;
use crate::commands::error::CommandError;
use crate::protocols::export::Staged;
use crate::shell::navigation_guard;
use crate::shell::pdf::{self, Paper};
use crate::startup::{self, Stage};

/// Load plus print; past it the export fails.
const DEADLINE: Duration = Duration::from_secs(30);

/// How long an engine that missed the deadline may still write its file before it is removed
/// anyway. The file goes once the engine answers, whichever comes first.
const LATE: Duration = Duration::from_secs(120);

/// The folder of the app's data the engine writes into, `0700` on unix.
const PRINT_DIR: &str = "export-print";

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
                "the printed PDF was not removed from the print folder: {error}"
            ),
        }
    }
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "sweep printed PDFs", sweep_at_startup);
}

/// Removes the PDFs an earlier run left when it ended mid export, off the startup thread.
fn sweep_at_startup(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let dir = app.state::<AppPaths>().data_dir.join(PRINT_DIR);
    tauri::async_runtime::spawn_blocking(move || sweep(&dir));
    Ok(())
}

fn sweep(dir: &Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            tracing::warn!(scope = "Export", "the print folder was not swept: {error}");
            return;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name
            .to_str()
            .is_some_and(|name| name.starts_with("memry-export-") && name.ends_with(".pdf"))
        {
            drop(TempFile(entry.path()));
        }
    }
}

/// [`PRINT_DIR`] of `data_dir`, made private to the user when it is missing.
fn print_dir(data_dir: &Path) -> Result<PathBuf, PdfError> {
    let dir = data_dir.join(PRINT_DIR);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(&dir)
        .map_err(|error| PdfError(format!("the print folder could not be made: {error}")))?;
    Ok(dir)
}

/// Past the deadline the engine may still write `output`: it is removed once the engine answers,
/// or after `late` when it never does.
fn discard_late(
    output: TempFile,
    on_done: oneshot::Receiver<Result<(), String>>,
    late: Duration,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(late, on_done).await;
        drop(output);
    })
}

/// `html` printed to PDF bytes with `paper`. The engine writes a file of its own, so the target
/// is written only with a whole PDF, as Electron's `fs.writeFile(targetPath, pdfData)` is.
pub async fn print_to_pdf(
    app: &AppHandle<Wry>,
    html: String,
    paper: Paper,
) -> Result<Vec<u8>, PdfError> {
    let label = WindowKind::PdfPrint.label(NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let page = Staged::new(html, label.clone());
    let dir = print_dir(&app.state::<AppPaths>().data_dir)?;
    let output = TempFile(dir.join(format!("memry-export-{}.pdf", Uuid::new_v4())));
    let (window, on_loaded) = open(app, &label, &page)?;
    let window = Destroy(window);
    // The page loads once the window is exempt from the app's main-frame guard, which would
    // refuse it on macOS.
    navigation_guard::exempt(&window.0);
    let (ready, on_ready) = oneshot::channel();
    let staged = page.url();
    window
        .0
        .with_webview(move |webview| {
            let _ = ready.send(pdf::prepare(&webview, &staged));
        })
        .map_err(|error| PdfError(format!("the print window is gone: {error}")))?;
    on_ready
        .await
        .map_err(|_| PdfError("the print window closed before it was guarded".into()))?
        .map_err(|error| PdfError(format!("the print window was not guarded: {error}")))?;
    window
        .0
        .navigate(page.url())
        .map_err(|error| PdfError(format!("the print window did not load the page: {error}")))?;
    let (done, mut on_done) = oneshot::channel();
    let printed = tokio::time::timeout(DEADLINE, async {
        on_loaded
            .await
            .map_err(|_| PdfError("the print window closed before the page loaded".into()))?;
        tokio::time::sleep(SETTLE).await;
        let target = output.0.clone();
        window
            .0
            .with_webview(move |webview| pdf::start(&webview, paper, &target, done))
            .map_err(|error| PdfError(format!("the print window is gone: {error}")))?;
        (&mut on_done)
            .await
            .map_err(|_| PdfError("the print engine never answered".into()))?
            .map_err(PdfError)
    })
    .await;
    match printed {
        Ok(result) => result?,
        Err(_) => {
            discard_late(output, on_done, LATE);
            return Err(PdfError("printing took longer than 30 seconds".into()));
        }
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

/// The print window `label` over `page`, and the signal that its page finished loading.
fn open(
    app: &AppHandle<Wry>,
    label: &str,
    page: &Staged,
) -> Result<(WebviewWindow<Wry>, oneshot::Receiver<()>), PdfError> {
    let (loaded, on_loaded) = oneshot::channel();
    let loaded = Mutex::new(Some(loaded));
    let url = page.url();
    let allowed = url.clone();
    let blank = Url::parse("about:blank").expect("about:blank parses");
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .title("MemryNote")
        .inner_size(800.0, 600.0)
        .visible(false)
        .focused(false)
        .focusable(false)
        .decorations(false)
        .skip_taskbar(true)
        .use_https_scheme(true)
        .disable_javascript()
        .on_navigation(move |to| pdf::may_load(to, &allowed))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished
                && pdf::is_page(payload.url(), &url)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_staged_page_is_the_only_one_the_print_window_loads() {
        let staged = Staged::new(String::new(), "pdf-print-1".to_owned());
        let other = Staged::new(String::new(), "pdf-print-1".to_owned());
        assert!(pdf::may_load(&staged.url(), &staged.url()));
        assert!(!pdf::may_load(&other.url(), &staged.url()));
    }

    #[test]
    fn a_file_written_past_the_deadline_goes_once_the_engine_answers() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("memry-export-late.pdf");
        let (done, on_done) = oneshot::channel();
        let task = discard_late(TempFile(path.clone()), on_done, Duration::from_secs(60));
        // The engine writes after the export gave up on it.
        std::fs::write(&path, b"%PDF-late").expect("late write");
        done.send(Ok(())).expect("the discard task listens");
        tauri::async_runtime::block_on(task).expect("the discard task ends");
        assert!(!path.exists());
    }

    #[test]
    fn a_file_whose_engine_never_answers_goes_after_the_backstop() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("memry-export-silent.pdf");
        std::fs::write(&path, b"%PDF-silent").expect("write");
        let (done, on_done) = oneshot::channel::<Result<(), String>>();
        let task = discard_late(TempFile(path.clone()), on_done, Duration::from_millis(10));
        tauri::async_runtime::block_on(task).expect("the discard task ends");
        assert!(!path.exists());
        drop(done);
    }

    #[cfg(unix)]
    #[test]
    fn the_print_folder_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().expect("temp dir");
        let dir = print_dir(data.path()).expect("print folder");
        let mode = std::fs::metadata(&dir)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_sweep_removes_printed_files_only() {
        let data = tempfile::tempdir().expect("temp dir");
        let dir = print_dir(data.path()).expect("print folder");
        let left = dir.join(format!("memry-export-{}.pdf", Uuid::new_v4()));
        let other = dir.join("notes.txt");
        std::fs::write(&left, b"%PDF-").expect("write");
        std::fs::write(&other, b"x").expect("write");
        sweep(&dir);
        assert!(!left.exists());
        assert!(other.exists());
    }
}

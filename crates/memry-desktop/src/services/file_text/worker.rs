//! The app's handle on the `memry-ml-worker` sidecar, which runs pdfium out of process (#3542,
//! R2). Replaces the Electron app's hidden PDF host page (`apps/desktop/src/main/file-text/
//! pdf-host.ts`): the child starts on the first call, a call past its timeout kills it, it is
//! restarted by the next call, it exits after a minute idle, and three crashes in a row pause it
//! for ten minutes (`memry_ml_worker::Supervisor`). Its stderr goes to `main.log`.
//!
//! It stops when the vault closes (the runner's `release`, `file-text/index.ts:26-29`) and in the
//! `stop-utility-processes` shutdown step.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_ml_worker::{Limits, PdfDocument, Supervisor, SystemClock, WorkerError};

/// Where the sidecar and the pdfium library are; the shell resolves both.
#[derive(Debug, Clone)]
pub struct WorkerPaths {
    pub program: PathBuf,
    pub pdfium_dir: PathBuf,
}

impl WorkerPaths {
    /// The sidecar sits next to the app's executable: Tauri's `externalBin` layout in a bundle,
    /// and Cargo's target dir in a dev build, which holds every workspace binary. pdfium sits
    /// under `pdfium/` in the resource dir, where `scripts/fetch-pdfium.mjs` writes it.
    pub fn new(exe_dir: &Path, resource_dir: &Path) -> Self {
        Self {
            program: exe_dir.join(memry_ml_worker::WORKER_BIN),
            pdfium_dir: resource_dir.join("pdfium"),
        }
    }
}

pub struct WorkerHandle {
    supervisor: Supervisor,
}

impl WorkerHandle {
    /// Starts nothing: the child starts on the first call.
    pub fn new(paths: WorkerPaths) -> Arc<Self> {
        Arc::new(Self {
            supervisor: Supervisor::new(
                paths.program,
                vec!["--pdfium-dir".into(), paths.pdfium_dir.into()],
                Limits::default(),
                Arc::new(SystemClock),
            ),
        })
    }

    pub fn open_pdf(&self, path: &Path) -> Result<PdfDocument<'_>, WorkerError> {
        self.supervisor.open_pdf(path)
    }

    /// Kills the child, if one runs, and fails the calls waiting on it.
    pub fn stop(&self) {
        self.supervisor.stop();
    }
}

/// What the file text runner reads PDFs with: the worker in the app (`openPdf` and `release` of
/// Electron's `FileTextDeps`, `runner.ts:89-92`). Errors are the worker's message.
pub trait PdfReader: Send + Sync {
    fn open(&self, path: &Path) -> Result<Box<dyn PdfPages + '_>, String>;

    /// Fails the calls in flight now (a stop).
    fn release(&self);
}

/// One open document (`PdfDocument` of `pdf-host.ts:26-39`). Pages count from 1.
pub trait PdfPages {
    fn page_count(&self) -> u32;
    fn page_text(&self, page: u32) -> Result<String, String>;
    /// The page as PNG, its long edge at most `max_edge` px.
    fn render_page(&self, page: u32, max_edge: u32) -> Result<Vec<u8>, String>;
    fn close(self: Box<Self>) -> Result<(), String>;
}

impl PdfReader for WorkerHandle {
    fn open(&self, path: &Path) -> Result<Box<dyn PdfPages + '_>, String> {
        let doc = self.open_pdf(path).map_err(|error| error.to_string())?;
        Ok(Box::new(doc))
    }

    fn release(&self) {
        self.stop();
    }
}

impl PdfPages for PdfDocument<'_> {
    fn page_count(&self) -> u32 {
        PdfDocument::page_count(self)
    }

    fn page_text(&self, page: u32) -> Result<String, String> {
        PdfDocument::page_text(self, page).map_err(|error| error.to_string())
    }

    fn render_page(&self, page: u32, max_edge: u32) -> Result<Vec<u8>, String> {
        PdfDocument::render_page(self, page, max_edge)
            .map(|rendered| rendered.png)
            .map_err(|error| error.to_string())
    }

    fn close(self: Box<Self>) -> Result<(), String> {
        PdfDocument::close(*self).map_err(|error| error.to_string())
    }
}

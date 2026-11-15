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

use crate::session::Session;

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

    pub fn register(self: &Arc<Self>, session: &Session) {
        let worker = self.clone();
        session.on_close("ml-worker", Arc::new(move |_| worker.stop()));
    }
}

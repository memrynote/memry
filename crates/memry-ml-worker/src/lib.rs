//! The out-of-process worker of MemryNote and the app's supervisor of it.
//!
//! pdfium is C++ and reads PDFs from the vault, which are untrusted input. It runs only in the
//! `memry-ml-worker` child process (#3542, R2), so a crash or a hang on a hostile file kills the
//! child, never the app. The app talks to it over stdin and stdout in length-prefixed frames
//! ([`frame`]) that carry the ops of [`op`]; [`supervisor::Supervisor`] owns the child, and
//! [`Supervisor::open_pdf`] is the typed PDF API over it.

pub mod frame;
pub mod op;
mod pdf_client;
mod priority;
pub mod serve;
pub mod supervisor;

pub use frame::{Frame, FrameError, MAX_FRAME_LEN};
pub use op::{MAX_RENDER_EDGE, OpError, Request, Response};
pub use pdf_client::{PdfDocument, RenderedPage};
pub use supervisor::{Clock, Limits, Supervisor, SystemClock, WorkerError};

/// The worker's file name next to the app's executable, where the bundle places the sidecar and
/// where Cargo places it in a dev build.
pub const WORKER_BIN: &str = if cfg!(windows) {
    "memry-ml-worker.exe"
} else {
    "memry-ml-worker"
};

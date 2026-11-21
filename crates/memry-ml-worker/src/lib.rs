//! The out-of-process worker of MemryNote and the app's supervisor of it.
//!
//! pdfium and Tesseract are C++ and read PDFs and images from the vault, which are untrusted
//! input. They run only in the `memry-ml-worker` child process (#3542, R1 and R2), so a crash or a
//! hang on a hostile file kills the child, never the app. The app talks to it over stdin and stdout
//! in length-prefixed frames ([`frame`]) that carry the ops of [`op`]; [`supervisor::Supervisor`]
//! owns the child, and [`Supervisor::open_pdf`] and [`Supervisor::recognize`] are the typed APIs
//! over it. ONNX Runtime (`memry-ml`) runs there too, on its own [`Supervisor`] (Kaan,
//! 2026-11-14): `Supervisor::embed_text` and its siblings. So does whisper.cpp, for voice
//! transcription (#3541): `Supervisor::transcribe`.

mod embed_client;
pub mod frame;
mod lifetime;
mod ocr_client;
pub mod op;
mod pdf_client;
mod priority;
pub mod serve;
pub mod supervisor;
mod transcribe_client;

pub use embed_client::AudioRecording;
pub use frame::{Frame, FrameError, MAX_FRAME_LEN};
pub use op::{
    EMBEDDING_DIMENSION, MAX_AUDIO_BYTES, MAX_AUDIO_WINDOWS, MAX_EMBED_IMAGE_BYTES,
    MAX_EMBED_TEXT_BYTES, MAX_FAILED_MESSAGE, MAX_LANGUAGE_BYTES, MAX_OCR_EDGE, MAX_OCR_LANGUAGES,
    MAX_RENDER_EDGE, MAX_TRANSCRIBE_BYTES, MODEL_REPO, MODEL_REVISION, Manifest, ManifestFile,
    ModelGroup, OpError, Request, Response,
};
pub use pdf_client::{PdfDocument, RenderedPage};
pub use supervisor::{
    Clock, ExitObserver, ExitPhase, Lease, Limits, Supervisor, SystemClock, WorkerError,
};

/// The worker's file name next to the app's executable, where the bundle places the sidecar and
/// where Cargo places it in a dev build.
pub const WORKER_BIN: &str = if cfg!(windows) {
    "memry-ml-worker.exe"
} else {
    "memry-ml-worker"
};

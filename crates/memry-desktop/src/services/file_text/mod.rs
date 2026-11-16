//! Reading text out of the vault's files (#3542). PDFs and OCR run in the `memry-ml-worker`
//! sidecar; [`WorkerHandle`] is the app's one owner of that process, and [`ocr`] prepares the
//! images it reads. HTML block files are read
//! in process ([`html`]). [`runner`] reads every file into `index.db`, one at a time, and
//! [`service::FileText`] runs it with the open vault.

pub mod html;
pub mod ocr;
pub mod runner;
pub mod service;
mod worker;

pub use worker::{PdfPages, PdfReader, WorkerHandle, WorkerPaths};

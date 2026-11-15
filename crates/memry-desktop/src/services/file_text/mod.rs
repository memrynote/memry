//! Reading text out of the vault's files (#3542). The PDF side runs in the `memry-ml-worker`
//! sidecar; [`WorkerHandle`] is the app's one owner of that process. HTML block files are read
//! in process ([`html`]). [`runner`] reads every file into `index.db`, one at a time, and
//! [`service::FileText`] runs it with the open vault.

pub mod html;
pub mod runner;
pub mod service;
mod worker;

pub use worker::{PdfPages, PdfReader, WorkerHandle, WorkerPaths};

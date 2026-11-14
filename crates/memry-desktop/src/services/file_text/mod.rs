//! Reading text out of the vault's files (#3542). The PDF side runs in the `memry-ml-worker`
//! sidecar; [`WorkerHandle`] is the app's one owner of that process.

mod worker;

pub use worker::{WorkerHandle, WorkerPaths};

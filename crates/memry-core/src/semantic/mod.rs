//! On-device semantic search (#4505): the pinned model and its download, the
//! embedder, and the one in-memory model slot. Everything here compiles with
//! or without the `semantic` feature; only the ONNX Runtime binding inside
//! `embedder` is gated, so host builds (`cargo test`, `memry-cli`, ubuntu CI)
//! link no ONNX Runtime.
//!
//! The public items are what `tests/embedding_parity.rs` needs; the shells
//! reach the rest through `api::semantic`.

pub(crate) mod download;
mod embedder;
#[cfg(test)]
pub(crate) mod fakes;
mod host;
mod model;
pub(crate) mod queue;

pub use embedder::{DIMENSION, Embed, Threads, Vector, load, truncate_renormalize};
pub use host::{Loader, ModelHost, ReleaseReason, WindowOutcome};
pub use model::{ModelDir, VerifiedModel};

use crate::api::errors::StorageError;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SemanticError {
    #[error("semantic search is not built into this binary")]
    Unavailable,
    #[error("embedding inference failed: {what}")]
    Inference { what: String },
    /// A panic during inference poisoned the session; only a reload clears it.
    #[error("the embedding session panicked and must be reloaded")]
    Poisoned,
    #[error(transparent)]
    Storage {
        #[from]
        source: StorageError,
    },
}

impl SemanticError {
    pub(crate) fn inference(what: impl std::fmt::Display) -> Self {
        Self::Inference {
            what: what.to_string(),
        }
    }
}

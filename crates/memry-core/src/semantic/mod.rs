//! On-device semantic search (#4505): the embedder and the one in-memory model
//! slot. Everything here compiles with or without the `semantic` feature; only
//! the ONNX Runtime binding inside `embedder` is gated, so host builds (`cargo
//! test`, `memry-cli`, ubuntu CI) link no ONNX Runtime.

mod embedder;
mod host;

pub use embedder::{DIMENSION, Embed, Threads, Vector, load, truncate_renormalize};
pub use host::{Loader, ModelHost};

#[derive(Debug, thiserror::Error)]
pub enum SemanticError {
    #[error("semantic search is not built into this binary")]
    Unavailable,
    #[error("embedding inference failed: {what}")]
    Inference { what: String },
}

impl SemanticError {
    pub(crate) fn inference(what: impl std::fmt::Display) -> Self {
        Self::Inference {
            what: what.to_string(),
        }
    }
}

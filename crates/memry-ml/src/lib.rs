//! Native ML of MemryNote: the EmbeddingGemma 2 model of Electron's embedding worker
//! (`apps/desktop/src/main/lib/embedding-worker.ts`) on an in-process ONNX Runtime.

mod engine;
mod files;
mod runtime;
mod text;

pub use engine::{
    EMBEDDING_DIMENSION, Embedding, EmbeddingEngine, LoadOptions, MAX_EMBEDDING_INPUT_LENGTH,
    default_intra_threads,
};
pub use files::{MODEL_REPO, MODEL_REVISION, ModelFile, ModelGroup, model_dir, verify};
pub use runtime::lower_thread_priority;

#[derive(Debug, thiserror::Error)]
pub enum MlError {
    /// A model file is absent or has the wrong size or hash.
    #[error("model file {0} is missing or incomplete")]
    ModelMissing(String),
    #[error("loading the model failed: {0}")]
    Load(String),
    #[error("inference failed: {0}")]
    Inference(String),
    /// The input cannot be embedded as given.
    #[error("{0}")]
    Input(String),
}

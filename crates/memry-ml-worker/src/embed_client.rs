//! The typed embedding calls over a [`Supervisor`], the requests of Electron's embedding utility
//! process (`apps/desktop/src/main/lib/embeddings.ts`). The worker loads the model from its
//! `--model-cache` on the first call of each child, so a call after a restart needs nothing
//! re-sent. A request over its cap fails here, before a frame is built.

use crate::op::{
    EMBEDDING_DIMENSION, MAX_EMBED_IMAGE_BYTES, MAX_EMBED_TEXT_BYTES, Manifest, ModelGroup,
    Request, Response,
};
use crate::supervisor::{Supervisor, WorkerError};

impl Supervisor {
    /// The pinned files of `group`, which the app downloads and hashes before a load.
    pub fn model_manifest(&self, group: ModelGroup) -> Result<Manifest, WorkerError> {
        match self.call(&Request::ModelManifest { group })? {
            Response::Manifest(manifest) => Ok(manifest),
            other => Err(unexpected(&other)),
        }
    }

    /// Loads the text model in the worker, unless it is loaded.
    pub fn embed_load(&self) -> Result<(), WorkerError> {
        match self.call(&Request::EmbedLoad)? {
            Response::Done => Ok(()),
            other => Err(unexpected(&other)),
        }
    }

    pub fn embed_text(&self, text: &str) -> Result<Vec<f32>, WorkerError> {
        if text.len() > MAX_EMBED_TEXT_BYTES {
            return Err(over_cap("text", text.len()));
        }
        embedded(self.call(&Request::EmbedText { text: text.into() })?)
    }

    pub fn embed_image(
        &self,
        bytes: &[u8],
        text: Option<&str>,
        soft_tokens: Option<u32>,
    ) -> Result<Vec<f32>, WorkerError> {
        if bytes.len() > MAX_EMBED_IMAGE_BYTES {
            return Err(over_cap("image", bytes.len()));
        }
        if let Some(text) = text.filter(|text| text.len() > MAX_EMBED_TEXT_BYTES) {
            return Err(over_cap("text", text.len()));
        }
        embedded(self.call(&Request::EmbedImage {
            bytes: bytes.to_vec(),
            text: text.map(str::to_owned),
            soft_tokens,
        })?)
    }
}

/// A NaN or infinity would reach the stored vectors and every similarity computed from them.
fn embedded(response: Response) -> Result<Vec<f32>, WorkerError> {
    match response {
        Response::Embedded(values) if values.iter().any(|value| !value.is_finite()) => Err(
            WorkerError::Protocol("an embedding with a value that is not finite".into()),
        ),
        Response::Embedded(values) if values.len() == EMBEDDING_DIMENSION => Ok(values),
        other => Err(unexpected(&other)),
    }
}

fn over_cap(what: &str, len: usize) -> WorkerError {
    WorkerError::Failed(format!(
        "the {what} of {len} bytes is over the embedding cap"
    ))
}

fn unexpected(response: &Response) -> WorkerError {
    WorkerError::Protocol(format!("unexpected answer {}", response.name()))
}

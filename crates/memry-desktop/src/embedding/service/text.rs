//! [`EmbeddingService::embed`] and [`EmbeddingService::embed_in_lane`]: `generateEmbedding` on
//! the text model, with the bridge's bookkeeping of a success, a crash and a failure.

use std::sync::Arc;
use std::time::Instant;

use super::thread::{Fault, Reply, Request};
use super::{EMBEDDING_DIMENSION, EmbeddingService, lock};
use crate::session::projection::CancelToken;

/// `MIN_CONTENT_LENGTH`: shorter text, in UTF-16 units after a JS `trim`, is not embedded.
const MIN_CONTENT_LENGTH: usize = 10;

/// JS `String.prototype.trim`: Rust's `White_Space` without U+0085, plus U+FEFF.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

impl EmbeddingService {
    /// `generateEmbedding`: the text's vector, or `None` when it is too short, loads back off, or
    /// the model failed.
    pub fn embed(self: &Arc<Self>, text: &str) -> Option<Vec<f32>> {
        self.embed_text(text, None)
    }

    /// [`Self::embed`] for a projection lane of the open vault: `None`, with no model started,
    /// once `lane` is cancelled. The token is read under the lock [`Self::stop`] takes, so a lane
    /// that checked it just before the vault closed cannot load the model again after the close
    /// hook stopped it (REVIEW-4548).
    pub fn embed_in_lane(self: &Arc<Self>, text: &str, lane: &CancelToken) -> Option<Vec<f32>> {
        self.embed_text(text, Some(lane))
    }

    fn embed_text(self: &Arc<Self>, text: &str, lane: Option<&CancelToken>) -> Option<Vec<f32>> {
        if js_trim(text).encode_utf16().count() < MIN_CONTENT_LENGTH {
            return None;
        }
        match self.infer(Request::Embed(text.to_owned()), lane)? {
            Reply::Embedded(vector) => Some(vector),
            Reply::Loaded | Reply::AudioOpened(_) => None,
        }
    }

    /// One inference with the bridge's bookkeeping: a success clears the embed failures, a crash
    /// drops the model and counts (`failProcess`), and a failure counts when the model was not
    /// loaded before the request.
    fn infer(self: &Arc<Self>, request: Request, lane: Option<&CancelToken>) -> Option<Reply> {
        let was_loaded = {
            let state = lock(&self.state);
            if state.breaker.is_open(Instant::now()) {
                return None;
            }
            state.loaded
        };
        let (generation, result) = self.request(request, lane);
        let mut state = lock(&self.state);
        if state.generation != generation {
            return None;
        }
        match result {
            Ok(Reply::Loaded | Reply::AudioOpened(_)) | Err(Fault::Retired | Fault::TimedOut) => {
                None
            }
            Ok(reply) => {
                if let Some(width) = reply.wrong_width() {
                    tracing::error!(
                        scope = "Embeddings",
                        "Unexpected dimension: {width} (expected {EMBEDDING_DIMENSION})"
                    );
                    return None;
                }
                state.loaded = true;
                state.loading = false;
                state.error = None;
                state.breaker.embed_failures = 0;
                state.breaker.record_success();
                Some(reply)
            }
            Err(Fault::Crashed(message)) => {
                // The thread dropped the model: the bridge's crashed worker (:709-735, :826-830).
                state.loaded = false;
                state.loading = false;
                tracing::error!(scope = "Embeddings", "Generation failed: {message}");
                state.error = Some(message);
                state.breaker.embed_failures += 1;
                Self::record_failure(&mut state);
                None
            }
            Err(Fault::Load(message) | Fault::Inference(message) | Fault::Input(message)) => {
                Self::failed(&mut state, message, !was_loaded)
            }
        }
    }
}

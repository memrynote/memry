//! [`EmbeddingService::embed_image`]: `embedImage` (embeddings.ts:407-417, 431-469) with the
//! vision encoder's breaker ([`super::encoder`]). The vision download (about 109 MB, on the
//! first image only) runs on the caller's thread, then the image is one request. A failure of
//! the request backs off images only, as Electron counts every `embed-image` error toward
//! `recordEncoderFailure('vision')`; text keeps embedding. An image the worker cannot decode
//! ([`super::EmbedError::Input`]) counts nowhere, so the images around it still embed.

use std::sync::Arc;

use super::EmbeddingService;
use super::encoder::Encoder;
use super::thread::{Reply, Request};
use crate::session::projection::CancelToken;

/// An image file's bytes or a rendered page, and how to embed it (`ImageEmbedOptions`): the
/// text interleaved with it and the encoder's soft-token budget (its default when `None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageInput {
    pub bytes: Vec<u8>,
    pub text: Option<String>,
    pub soft_tokens: Option<u32>,
}

impl EmbeddingService {
    /// `generateImageEmbedding` past its settings gate: the image's vector, or `None` when it is
    /// empty, text or images back off, the encoder failed, or `lane` is cancelled (as
    /// [`EmbeddingService::embed_in_lane`]). Blocks on the vision download: call it from a
    /// blocking thread.
    pub fn embed_image(
        self: &Arc<Self>,
        image: ImageInput,
        lane: &CancelToken,
    ) -> Option<Vec<f32>> {
        if image.bytes.is_empty() || !self.prepare_encoder(Encoder::Vision) {
            return None;
        }
        let request = Request::EmbedImage(Box::new(image));
        match self.encoder_request(Encoder::Vision, request, None, Some(lane))? {
            (generation, Reply::Embedded(vector)) => self
                .encoder_succeeded(Encoder::Vision, generation)
                .then_some(vector),
            _ => None,
        }
    }
}

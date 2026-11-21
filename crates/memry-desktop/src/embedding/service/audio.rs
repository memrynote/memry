//! [`EmbeddingService::embed_audio`]: `embedAudio` (`apps/desktop/src/main/lib/audio-embedding.ts`)
//! with the audio encoder's breaker ([`super::encoder`]). The audio download runs on the caller's
//! thread, then the open and each window are their own requests with their own deadline
//! (embeddings.ts:792-798), so text runs between them. A recording that crashes or hangs the
//! worker, an audio download that fails and an audio model that does not load back off audio
//! only; a file the worker cannot read or decode ([`super::EmbedError::Input`]) counts nowhere.
//! Its caller, the voice memo projector ([`crate::embedding::voice_projector`]), owns the gates
//! `embedAudio` checks first (`ai.enabled`, `voiceTranscription.audioSearch`, a `.wav` name).

use std::path::Path;
use std::sync::Arc;

use super::EmbeddingService;
use super::encoder::Encoder;
use super::thread::{Reply, Request};

/// A recording an [`super::Engine`] holds open: its handle and its 30 s windows, none for a
/// recording under one second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioOpened {
    pub recording: u64,
    pub windows: u32,
}

impl EmbeddingService {
    /// `embedAudio` past its settings gates: one vector per 30 s window of the WAV file at `path`,
    /// or `None` when the recording is under one second, text or audio loads back off, the file
    /// cannot be read or decoded, or any window failed (a partial set would index only the start).
    /// Blocks on the audio download: call it from a blocking thread.
    pub fn embed_audio(self: &Arc<Self>, path: &Path) -> Option<Vec<Vec<f32>>> {
        if !self.prepare_encoder(Encoder::Audio) {
            return None;
        }
        let open = Request::OpenAudio(path.into());
        let (generation, opened) = match self.encoder_request(Encoder::Audio, open, None, None)? {
            (generation, Reply::AudioOpened(opened)) => (generation, opened),
            _ => return None,
        };
        // A recording under one second loaded nothing of the encoder: not a success.
        if opened.windows == 0 {
            return None;
        }
        let mut vectors = Vec::with_capacity(opened.windows as usize);
        for window in 0..opened.windows {
            let request = Request::AudioWindow {
                recording: opened.recording,
                window,
            };
            match self.encoder_request(Encoder::Audio, request, Some(generation), None)? {
                (_, Reply::Embedded(vector)) => vectors.push(vector),
                _ => return None,
            }
        }
        self.encoder_succeeded(Encoder::Audio, generation)
            .then_some(vectors)
    }
}

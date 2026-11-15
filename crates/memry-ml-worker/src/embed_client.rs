//! The typed embedding calls over a [`Supervisor`], the requests of Electron's embedding utility
//! process (`apps/desktop/src/main/lib/embeddings.ts`). The worker loads the model from its
//! `--model-cache` on the first call of each child, so a call after a restart needs nothing
//! re-sent. A request over its cap fails here, before a frame is built.
//!
//! A recording is embedded window by window ([`AudioRecording`]), Electron's `embedAudio` calling
//! `generateAudioEmbedding` once per window (`apps/desktop/src/main/lib/audio-embedding.ts`): the
//! worker reads and decodes the file, so neither the file (up to 512 MiB) nor its samples cross
//! the pipe, and each window is one op under the supervisor's op timeout. A recording lives in one
//! worker, as a PDF document does: after a restart its calls fail with "not open".

use std::path::Path;

use crate::op::{
    EMBEDDING_DIMENSION, MAX_EMBED_IMAGE_BYTES, MAX_EMBED_TEXT_BYTES, Manifest, ModelGroup,
    Request, Response,
};
use crate::supervisor::{Lease, Supervisor, WorkerError};

/// A WAV file decoded in the worker, held there until it is closed or the next one is opened.
pub struct AudioRecording<'a> {
    worker: &'a Supervisor,
    lease: Lease,
    recording: u32,
    windows: u32,
}

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

    /// Decodes the WAV file at `path` in the worker. A file the worker cannot read, one over
    /// [`crate::MAX_AUDIO_BYTES`] and one that is not a WAV it decodes are [`WorkerError::Failed`].
    pub fn open_audio(&self, path: &Path) -> Result<AudioRecording<'_>, WorkerError> {
        let path = path
            .to_str()
            .ok_or_else(|| WorkerError::Failed(format!("{} is not valid UTF-8", path.display())))?;
        match self.call_leasing(&Request::AudioOpen { path: path.into() })? {
            (Response::AudioOpened { recording, windows }, lease) => Ok(AudioRecording {
                worker: self,
                lease,
                recording,
                windows,
            }),
            (other, _) => Err(unexpected(&other)),
        }
    }
}

impl AudioRecording<'_> {
    /// The 30 s windows to embed, none for a recording under one second.
    pub fn windows(&self) -> u32 {
        self.windows
    }

    pub fn embed_window(&self, window: u32) -> Result<Vec<f32>, WorkerError> {
        embedded(self.worker.call_on(
            &self.lease,
            &Request::EmbedAudioWindow {
                recording: self.recording,
                window,
            },
        )?)
    }

    /// Frees the decoded samples in the worker.
    pub fn close(self) -> Result<(), WorkerError> {
        match self.worker.call_on(
            &self.lease,
            &Request::AudioClose {
                recording: self.recording,
            },
        )? {
            Response::Done => Ok(()),
            other => Err(unexpected(&other)),
        }
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

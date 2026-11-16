//! [`EmbeddingService::embed_audio`]: the audio download on the caller's thread, then the open and
//! each window as their own requests on the embedding thread, with the audio encoder's breaker.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use super::thread::{Fault, Reply, Request};
use super::{EmbeddingService, State, lock};
use crate::embedding::download::Abort;

impl EmbeddingService {
    /// `embedAudio` past its settings gates: one vector per 30 s window of the WAV file at `path`,
    /// or `None` when the recording is under one second, text or audio loads back off, the file
    /// cannot be read or decoded, or any window failed (a partial set would index only the start).
    /// Blocks on the audio download: call it from a blocking thread.
    pub fn embed_audio(self: &Arc<Self>, path: &Path) -> Option<Vec<Vec<f32>>> {
        let cancel = {
            let mut state = lock(&self.state);
            let now = Instant::now();
            if state.breaker.is_open(now) || state.audio.is_open(now) {
                return None;
            }
            if let Err(error) = self.ensure_worker(&mut state) {
                state.error = Some(format!("the embedding thread did not start: {error}"));
                return None;
            }
            state.worker.as_ref().expect("ensured above").cancel.clone()
        };
        let abort = Abort {
            cancel,
            deadline: Instant::now() + self.timing.request_deadline,
        };
        if let Err(message) = self.loader.prepare_audio(&abort) {
            // A stop (vault close, quit) is not a failure.
            if !abort.cancel.is_cancelled() {
                Self::audio_failed(&mut lock(&self.state), message);
            }
            return None;
        }
        let (generation, opened) =
            match self.audio_request(Request::OpenAudio(path.into()), None)? {
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
            match self.audio_request(request, Some(generation))? {
                (_, Reply::Embedded(vector)) => vectors.push(vector),
                _ => return None,
            }
        }
        let mut state = lock(&self.state);
        if state.generation != generation {
            return None;
        }
        state.audio.clear();
        state.error = None;
        Some(vectors)
    }

    /// One audio request with `recordEncoderFailure('audio')`'s bookkeeping: a crash, a timeout
    /// (in [`Self::time_out`]) or an encoder failure backs off audio only; a text model load
    /// failure counts as the text load it is; a file fault counts nowhere. `generation` pins the
    /// windows to the thread that opened the recording.
    fn audio_request(
        self: &Arc<Self>,
        request: Request,
        generation: Option<u64>,
    ) -> Option<(u64, Reply)> {
        let (served_by, result) = self.request(request);
        let mut state = lock(&self.state);
        if state.generation != served_by || generation.is_some_and(|g| g != served_by) {
            return None;
        }
        state.loading = false;
        match result {
            Ok(Reply::Loaded) | Err(Fault::Retired | Fault::TimedOut) => None,
            Ok(reply) => match reply.wrong_width() {
                Some(width) => {
                    Self::audio_failed(&mut state, format!("Unexpected dimension: {width}"));
                    None
                }
                None => {
                    state.loaded = true;
                    Some((served_by, reply))
                }
            },
            Err(Fault::Crashed(message)) => {
                state.loaded = false;
                Self::audio_failed(&mut state, message);
                None
            }
            Err(Fault::Inference(message)) => {
                Self::audio_failed(&mut state, message);
                None
            }
            Err(Fault::Load(message)) => {
                Self::failed(&mut state, message, true);
                None
            }
            Err(Fault::Input(message)) => {
                Self::failed(&mut state, message, false);
                None
            }
        }
    }

    /// `recordEncoderFailure('audio')`.
    pub(super) fn audio_failed(state: &mut State, message: String) {
        let delay = state.audio.record_failure(Instant::now());
        tracing::warn!(
            scope = "Embeddings",
            attempt = state.audio.failures,
            retry_in_ms = delay.as_millis() as u64,
            "audio embedding failed — backing off before retry: {message}"
        );
        state.error = Some(message);
    }
}

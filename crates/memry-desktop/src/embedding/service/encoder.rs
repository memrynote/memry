//! The audio and vision encoders' shared bookkeeping (`embedWithEncoder` and
//! `recordEncoderFailure`, embeddings.ts:247-254, 431-500, 830-832): each runs behind the text
//! breaker and feeds only its own [`EncoderBreaker`](crate::embedding::breaker::EncoderBreaker),
//! so a file that crashes or hangs the worker, or an encoder download that keeps failing, never
//! stops text indexing.

use std::sync::Arc;
use std::time::Instant;

use super::thread::{Fault, Reply, Request};
use super::{EmbeddingService, State, lock};
use crate::embedding::breaker::EncoderBreaker;
use crate::embedding::download::Abort;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Encoder {
    Audio,
    Vision,
}

impl Encoder {
    fn breaker(self, state: &mut State) -> &mut EncoderBreaker {
        match self {
            Self::Audio => &mut state.audio,
            Self::Vision => &mut state.vision,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Audio => "audio",
            Self::Vision => "vision",
        }
    }
}

impl EmbeddingService {
    /// The encoder's files, downloaded on the caller's thread: `false` when text or the encoder
    /// back off, the thread does not start, or the download fails (which counts, unless a stop
    /// cancelled it).
    pub(super) fn prepare_encoder(self: &Arc<Self>, encoder: Encoder) -> bool {
        let cancel = {
            let mut state = lock(&self.state);
            let now = Instant::now();
            if state.breaker.is_open(now) || encoder.breaker(&mut state).is_open(now) {
                return false;
            }
            if let Err(error) = self.ensure_worker(&mut state) {
                state.error = Some(format!("the embedding thread did not start: {error}"));
                return false;
            }
            state.worker.as_ref().expect("ensured above").cancel.clone()
        };
        let abort = Abort {
            cancel,
            deadline: Instant::now() + self.timing.request_deadline,
        };
        let prepared = match encoder {
            Encoder::Audio => self.loader.prepare_audio(&abort),
            Encoder::Vision => self.loader.prepare_vision(&abort),
        };
        match prepared {
            Ok(()) => true,
            Err(message) => {
                // A stop (vault close, quit) is not a failure.
                if !abort.cancel.is_cancelled() {
                    Self::encoder_failed(&mut lock(&self.state), encoder, message);
                }
                false
            }
        }
    }

    /// One encoder request with `recordEncoderFailure`'s bookkeeping: a crash, a timeout (in
    /// [`Self::time_out`]), an encoder failure or a vector of the wrong width backs off the
    /// encoder only; a text model load failure counts as the text load it is; a file fault
    /// counts nowhere. `generation` pins a request to the thread that served an earlier one.
    pub(super) fn encoder_request(
        self: &Arc<Self>,
        encoder: Encoder,
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
                    let message = format!("Unexpected dimension: {width}");
                    Self::encoder_failed(&mut state, encoder, message);
                    None
                }
                None => {
                    state.loaded = true;
                    Some((served_by, reply))
                }
            },
            Err(Fault::Crashed(message)) => {
                state.loaded = false;
                Self::encoder_failed(&mut state, encoder, message);
                None
            }
            Err(Fault::Inference(message)) => {
                Self::encoder_failed(&mut state, encoder, message);
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

    /// The encoder delivered: its backoff and the error clear (`breaker.failures = 0`).
    pub(super) fn encoder_succeeded(&self, encoder: Encoder, generation: u64) -> bool {
        let mut state = lock(&self.state);
        if state.generation != generation {
            return false;
        }
        encoder.breaker(&mut state).clear();
        state.error = None;
        true
    }

    /// `recordEncoderFailure(encoder)`.
    pub(super) fn encoder_failed(state: &mut State, encoder: Encoder, message: String) {
        let breaker = encoder.breaker(state);
        let delay = breaker.record_failure(Instant::now());
        tracing::warn!(
            scope = "Embeddings",
            attempt = breaker.failures,
            retry_in_ms = delay.as_millis() as u64,
            "{} embedding failed — backing off before retry: {message}",
            encoder.name()
        );
        state.error = Some(message);
    }
}

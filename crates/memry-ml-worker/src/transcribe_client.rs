//! The typed transcription calls over a [`Supervisor`], the requests of Electron's voice
//! transcription utility process (`apps/desktop/src/main/inbox/voice-model.ts`). The app runs them
//! on a supervisor of their own, whose [`Limits::op_timeout`](crate::Limits::op_timeout) is the
//! 5 min `REQUEST_TIMEOUT_MS`: a read past it kills the child. A request over its cap fails here,
//! before a frame is built.

use std::path::Path;

use crate::op::{MAX_LANGUAGE_BYTES, MAX_TRANSCRIBE_BYTES, Request, Response};
use crate::supervisor::{Supervisor, WorkerError};

impl Supervisor {
    /// Loads the ggml model at `model` in the worker, unless it is loaded.
    pub fn transcribe_load(&self, model: &Path) -> Result<(), WorkerError> {
        let model = utf8(model)?;
        match self.call(&Request::TranscribeLoad { model })? {
            Response::Done => Ok(()),
            other => Err(unexpected(&other)),
        }
    }

    /// The text Whisper hears in `wav`, a WAV file, in `language` (a Whisper code such as `en`).
    /// The worker loads `model` first when it is not loaded. A file it cannot decode and an
    /// unknown language are [`WorkerError::Rejected`]; a language that is not ASCII letters is
    /// rejected here, with no child started.
    pub fn transcribe(
        &self,
        model: &Path,
        language: &str,
        wav: &[u8],
    ) -> Result<String, WorkerError> {
        if wav.len() > MAX_TRANSCRIBE_BYTES {
            return Err(WorkerError::Failed(format!(
                "the recording of {} bytes is over the {MAX_TRANSCRIBE_BYTES}-byte cap",
                wav.len()
            )));
        }
        // Whisper's codes are ASCII letters; anything else would cost a decode and a model load
        // before the worker refuses it.
        if language.is_empty()
            || language.len() > MAX_LANGUAGE_BYTES
            || !language.bytes().all(|byte| byte.is_ascii_alphabetic())
        {
            return Err(WorkerError::Rejected(format!(
                "unknown transcription language {language}"
            )));
        }
        let request = Request::Transcribe {
            model: utf8(model)?,
            language: language.into(),
            wav: wav.to_vec(),
        };
        match self.call(&request)? {
            Response::Text(text) => Ok(text),
            other => Err(unexpected(&other)),
        }
    }
}

fn utf8(model: &Path) -> Result<String, WorkerError> {
    model
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| WorkerError::Failed("the model's path is not valid UTF-8".into()))
}

fn unexpected(response: &Response) -> WorkerError {
    WorkerError::Protocol(format!("unexpected answer {}", response.name()))
}

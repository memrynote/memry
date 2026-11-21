//! The transcription ops on `memry_ml::WhisperEngine` (whisper.cpp), out of the app's process as
//! Electron's voice transcription utility process ran them (`voice-transcription-worker.ts`): a
//! crash or a hang in whisper.cpp ends this child, never the app. The app runs these ops on a
//! worker of their own, so this child loads no other model.
//!
//! The recording is untrusted: it crosses the pipe as a WAV file of at most
//! [`memry_ml_worker::MAX_TRANSCRIBE_BYTES`]. Its language is checked and it is decoded by
//! `memry_ml::decode_wav` (bounded, resampled to 16 kHz mono) before the model loads. A file that
//! does not decode and an unknown language are the input's fault ([`Response::Rejected`]); a model
//! that does not load fails.

use std::path::{Path, PathBuf};

use memry_ml::{MlError, WhisperEngine};
use memry_ml_worker::{Request, Response};

#[derive(Default)]
pub struct Transcriber {
    /// The loaded model and the path it was loaded from.
    loaded: Option<(PathBuf, WhisperEngine)>,
}

impl Transcriber {
    pub fn handle(&mut self, request: Request) -> Response {
        let outcome = match request {
            Request::TranscribeLoad { model } => {
                self.engine(Path::new(&model)).map(|_| Response::Done)
            }
            Request::Transcribe {
                model,
                language,
                wav,
            } => WhisperEngine::check_language(&language)
                .and_then(|()| memry_ml::decode_wav(&wav))
                .and_then(|samples| {
                    drop(wav);
                    let text = self
                        .engine(Path::new(&model))?
                        .transcribe(&samples, &language)?;
                    Ok(Response::Text(text))
                }),
            other => {
                return Response::Failed(format!("{} is not a transcription op", other.name()));
            }
        };
        outcome.unwrap_or_else(|error| match error {
            MlError::Input(message) => Response::Rejected(message),
            error => Response::Failed(error.to_string()),
        })
    }

    fn engine(&mut self, model: &Path) -> Result<&WhisperEngine, MlError> {
        if self.loaded.as_ref().is_none_or(|(path, _)| path != model) {
            // The old model's memory goes before the next one loads.
            self.loaded = None;
            let engine = load(model)?;
            self.loaded = Some((model.to_path_buf(), engine));
        }
        Ok(&self.loaded.as_ref().expect("loaded above").1)
    }
}

/// whisper.cpp opens the model with narrow `fopen`, which MSVC reads in the ANSI code page, so a
/// profile dir like `C:\Users\Çağrı` would never open (as Tesseract's data, `ocr.rs`). The worker
/// moves into the model's dir with the wide-character API and hands whisper.cpp the file name.
fn load(model: &Path) -> Result<WhisperEngine, MlError> {
    let (Some(dir), Some(name)) = (model.parent(), model.file_name()) else {
        return Err(MlError::Load("the Whisper model has no file name".into()));
    };
    std::env::set_current_dir(dir)
        .map_err(|error| MlError::Load(format!("the Whisper model's dir did not open: {error}")))?;
    WhisperEngine::load(Path::new(name))
}

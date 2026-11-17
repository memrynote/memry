//! Speech to text on whisper.cpp (`whisper-rs`), the native engine of Electron's voice
//! transcription worker (`apps/desktop/src/main/inbox/voice-transcription-worker.ts`), which ran
//! `Xenova/whisper-small` on transformers.js. This one reads the ggml file of the same model
//! (`ggml-small.bin`), which the app downloads and checks. It runs only in `memry-ml-worker`, as
//! every C and C++ reader does: a crash in whisper.cpp ends that child, never the app.
//!
//! The samples are 16 kHz mono, as `decode_wav` gives them. Greedy decoding, no translation, the
//! language the caller names (the service applies Electron's default `en`). The text is the
//! segments joined and trimmed, as `normalizeTranscriptionResult` trims the pipeline's text.

use std::path::Path;

use crate::MlError;

/// The threads one transcription uses: at most four, so the app keeps cores for itself.
#[cfg(not(all(windows, target_arch = "aarch64")))]
fn threads() -> i32 {
    std::thread::available_parallelism().map_or(1, |n| n.get().min(4)) as i32
}

#[cfg(not(all(windows, target_arch = "aarch64")))]
pub struct WhisperEngine {
    context: whisper_rs::WhisperContext,
}

#[cfg(not(all(windows, target_arch = "aarch64")))]
impl WhisperEngine {
    /// Loads the ggml model at `model`. whisper.cpp logs nothing: its log hooks are installed
    /// with no backend, so a load writes no lines to the worker's stderr.
    pub fn load(model: &Path) -> Result<Self, MlError> {
        whisper_rs::install_logging_hooks();
        let context = whisper_rs::WhisperContext::new_with_params(
            model,
            whisper_rs::WhisperContextParameters::default(),
        )
        .map_err(|error| MlError::Load(format!("the Whisper model did not load: {error}")))?;
        Ok(Self { context })
    }

    /// The text in `samples` (16 kHz mono). An unknown `language` and an empty recording are
    /// [`MlError::Input`].
    pub fn transcribe(&self, samples: &[f32], language: &str) -> Result<String, MlError> {
        if whisper_rs::get_lang_id(language).is_none() {
            return Err(MlError::Input(format!(
                "unknown transcription language {language}"
            )));
        }
        if samples.is_empty() {
            return Err(MlError::Input("the recording holds no audio".into()));
        }
        let inference = |error: whisper_rs::WhisperError| MlError::Inference(error.to_string());
        let mut state = self.context.create_state().map_err(inference)?;
        let mut params =
            whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(threads());
        params.set_language(Some(language));
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state.full(params, samples).map_err(inference)?;
        let mut text = String::new();
        for segment in state.as_iter() {
            text.push_str(&segment.to_str_lossy().map_err(inference)?);
        }
        Ok(text.trim().to_owned())
    }
}

/// Windows ARM64 builds no whisper.cpp yet: ggml's ARM CPU code needs clang, and its MSVC build
/// stops there. Every load fails with the reason, so the app shows it.
#[cfg(all(windows, target_arch = "aarch64"))]
pub enum WhisperEngine {}

#[cfg(all(windows, target_arch = "aarch64"))]
impl WhisperEngine {
    pub fn load(_model: &Path) -> Result<Self, MlError> {
        Err(MlError::Load(
            "local transcription is not available on Windows ARM64 yet".into(),
        ))
    }

    pub fn transcribe(&self, _samples: &[f32], _language: &str) -> Result<String, MlError> {
        match *self {}
    }
}

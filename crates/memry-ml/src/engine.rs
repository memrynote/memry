//! `EmbeddingEngine`: the loaded model and the embedding calls of Electron's embedding worker.

use std::borrow::Cow;
use std::path::Path;

use crate::MlError;
use crate::audio::{AudioEncoder, audio_prompt};
use crate::audio_prep::audio_features;
use crate::files::{self, ModelGroup};
use crate::text::TextModel;

/// Stored vector width: the first 256 of the model's 768 dimensions (Matryoshka), re-normalised.
pub const EMBEDDING_DIMENSION: usize = 256;

/// UTF-16 code units of one text the worker embeds (`MAX_EMBEDDING_INPUT_LENGTH`).
pub const MAX_EMBEDDING_INPUT_LENGTH: usize = 4000;

pub type Embedding = [f32; EMBEDDING_DIMENSION];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoadOptions {
    /// ONNX Runtime threads within one operator.
    pub intra_threads: usize,
}

impl Default for LoadOptions {
    fn default() -> Self {
        Self {
            intra_threads: default_intra_threads(),
        }
    }
}

/// The worker's `INFERENCE_THREADS`: half the cores, at least one and at most two, so a
/// vault-wide embed never takes the whole machine.
pub fn default_intra_threads() -> usize {
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    (cores / 2).clamp(1, 2)
}

/// The text model, loaded from a model directory (`files::model_dir`), and the audio encoder once
/// [`EmbeddingEngine::load_audio`] ran. Inference takes `&mut self`: one thread owns the engine and
/// serves one request at a time.
pub struct EmbeddingEngine {
    text: TextModel,
    audio: Option<AudioEncoder>,
    intra_threads: usize,
}

impl EmbeddingEngine {
    /// Loads the text group. Fails with `ModelMissing` before reading anything when a file is
    /// absent or has the wrong size; the hash check is `files::verify`, run after a download.
    pub fn load(dir: &Path, options: LoadOptions) -> Result<Self, MlError> {
        files::ensure_present(dir, ModelGroup::Text)?;
        Ok(Self {
            text: TextModel::load(dir, options.intra_threads)?,
            audio: None,
            intra_threads: options.intra_threads,
        })
    }

    /// Loads the audio encoder from `dir` unless it is loaded: the worker's
    /// `loadEmbeddingPipeline({ audio: true })`, reached on the first recording to embed. Fails with
    /// `ModelMissing` when a file of the audio group is absent or has the wrong size.
    pub fn load_audio(&mut self, dir: &Path) -> Result<(), MlError> {
        if self.audio.is_none() {
            files::ensure_present(dir, ModelGroup::Audio)?;
            self.audio = Some(AudioEncoder::load(dir, self.intra_threads)?);
        }
        Ok(())
    }

    /// Embeds one window of 16 kHz mono samples (`audio_prep::audio_windows`) as the worker's
    /// `embedAudio`: the window's features, the encoder's soft tokens at the prompt's placeholders.
    pub fn embed_audio(&mut self, window: &[f32]) -> Result<Embedding, MlError> {
        let Some(encoder) = self.audio.as_mut() else {
            return Err(MlError::Load("Audio encoder is not loaded".into()));
        };
        let features = audio_features(window)?;
        let soft_tokens = encoder.encode(&features)?;
        let ids = self.text.token_ids(&audio_prompt(features.soft_tokens()))?;
        truncate_embedding(&self.text.sentence_embedding_with_audio(ids, soft_tokens)?)
    }

    /// The ids [`Self::embed_audio`] gives the model for `window`.
    pub fn audio_token_ids(&self, window: &[f32]) -> Result<Vec<i64>, MlError> {
        self.text
            .token_ids(&audio_prompt(audio_features(window)?.soft_tokens()))
    }

    /// Embeds the first [`MAX_EMBEDDING_INPUT_LENGTH`] UTF-16 units of `text` as given: the
    /// caller adds the task prefix (`memry_core::domain::embedding_input`).
    pub fn embed_text(&mut self, text: &str) -> Result<Embedding, MlError> {
        let ids = self.token_ids(text)?;
        truncate_embedding(&self.text.sentence_embedding(ids)?)
    }

    /// The ids [`Self::embed_text`] gives the model for `text`: `<bos>`, the first
    /// [`MAX_EMBEDDING_INPUT_LENGTH`] UTF-16 units tokenized, `<eos>`.
    pub fn token_ids(&self, text: &str) -> Result<Vec<i64>, MlError> {
        self.text
            .token_ids(&utf16_prefix(text, MAX_EMBEDDING_INPUT_LENGTH))
    }
}

/// `text.substring(0, max_units)`. A cut through a surrogate pair keeps its first half as U+FFFD,
/// as `memry_core::domain::embedding_input` does, where JavaScript keeps a lone surrogate.
fn utf16_prefix(text: &str, max_units: usize) -> Cow<'_, str> {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if units + width > max_units {
            if units == max_units {
                return Cow::Borrowed(&text[..index]);
            }
            return Cow::Owned(format!("{}\u{FFFD}", &text[..index]));
        }
        units += width;
    }
    Cow::Borrowed(text)
}

/// The worker's `truncateEmbedding`: the first [`EMBEDDING_DIMENSION`] values, divided by their
/// norm. The norm sums the f32 values in f64 and each quotient rounds back to f32, as the
/// JavaScript arithmetic on a `Float32Array` does.
pub(crate) fn truncate_embedding(full: &[f32]) -> Result<Embedding, MlError> {
    if full.len() < EMBEDDING_DIMENSION {
        return Err(MlError::Inference(format!(
            "Unexpected dimension: {} (expected >= {EMBEDDING_DIMENSION})",
            full.len()
        )));
    }
    let mut out = [0.0_f32; EMBEDDING_DIMENSION];
    out.copy_from_slice(&full[..EMBEDDING_DIMENSION]);
    let norm = out
        .iter()
        .map(|&value| f64::from(value) * f64::from(value))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return Err(MlError::Inference("Embedding is not finite".into()));
    }
    for value in &mut out {
        *value = (f64::from(*value) / norm) as f32;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_prefix_counts_units_and_replaces_a_split_pair() {
        assert_eq!(utf16_prefix("abc", 3), "abc");
        assert_eq!(utf16_prefix("abcd", 3), "abc");
        assert_eq!(utf16_prefix("ağç", 2), "ağ");
        // U+1F600 is two units: a cut after its first half keeps U+FFFD.
        assert_eq!(utf16_prefix("a\u{1F600}b", 2), "a\u{FFFD}");
        assert_eq!(utf16_prefix("a\u{1F600}b", 3), "a\u{1F600}");
        assert_eq!(utf16_prefix("", 4000), "");
    }

    #[test]
    fn truncate_embedding_keeps_256_values_divided_by_their_norm() {
        let mut full = vec![0.0_f32; 768];
        full[0] = 3.0;
        full[1] = 4.0;
        full[300] = 100.0;
        let out = truncate_embedding(&full).expect("finite");
        assert_eq!(out[0], 0.6);
        assert_eq!(out[1], 0.8);
        assert!(out[2..].iter().all(|&value| value == 0.0));

        // 0.1f32 squared and summed in f64, then each quotient rounded to f32.
        let tenths = vec![0.1_f32; 256];
        let norm = (256.0 * f64::from(0.1_f32) * f64::from(0.1_f32)).sqrt();
        let expected = (f64::from(0.1_f32) / norm) as f32;
        assert!(
            truncate_embedding(&tenths)
                .expect("finite")
                .iter()
                .all(|&v| v == expected)
        );
    }

    #[test]
    fn truncate_embedding_refuses_short_zero_and_non_finite_vectors() {
        let short = truncate_embedding(&[1.0; 255]).expect_err("short");
        assert_eq!(
            short.to_string(),
            "inference failed: Unexpected dimension: 255 (expected >= 256)"
        );
        let zero = truncate_embedding(&[0.0; 768]).expect_err("zero");
        assert_eq!(
            zero.to_string(),
            "inference failed: Embedding is not finite"
        );
        let mut nan = vec![0.5_f32; 768];
        nan[7] = f32::NAN;
        assert!(truncate_embedding(&nan).is_err());
    }

    #[test]
    fn default_intra_threads_is_one_or_two() {
        assert!((1..=2).contains(&default_intra_threads()));
    }

    #[test]
    fn load_reports_a_missing_model_before_touching_onnx_runtime() {
        let dir = tempfile::Builder::new()
            .prefix("memry-ml-engine")
            .tempdir()
            .expect("tempdir");
        let error = EmbeddingEngine::load(dir.path(), LoadOptions::default())
            .err()
            .expect("empty");
        assert!(matches!(error, MlError::ModelMissing(ref path) if path == "tokenizer.json"));
    }
}

//! The text graph: the tokenizer and `model_q4.onnx`, which turns a prompt into the model's
//! mean-pooled, projected and L2-normalised `sentence_embedding`.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;
use tokenizers::Tokenizer;

use crate::MlError;
use crate::files::{TEXT_GRAPH, TOKENIZER, file_path};
use crate::runtime::session_builder;

/// Placeholder ids the processor expands an image, a video or an audio clip into
/// (`image_token_id`, `video_token_id`, `audio_token_id` of the model's `config.json`).
const PLACEHOLDERS: [(&str, i64); 3] = [("image", 258_880), ("video", 258_884), ("audio", 258_881)];

/// Width of one soft token (`text_config.hidden_size`).
pub(crate) const SOFT_TOKEN_WIDTH: usize = 512;

/// Width of `sentence_embedding`.
pub(crate) const SENTENCE_EMBEDDING_WIDTH: usize = 768;

pub(crate) struct TextModel {
    tokenizer: Tokenizer,
    session: Session,
}

impl TextModel {
    pub(crate) fn load(dir: &Path, intra_threads: usize) -> Result<Self, MlError> {
        let tokenizer = Tokenizer::from_file(file_path(dir, &TOKENIZER))
            .map_err(|error| MlError::Load(format!("tokenizer: {error}")))?;
        let session = session_builder(intra_threads)?
            .commit_from_file(file_path(dir, &TEXT_GRAPH))
            .map_err(|error| MlError::Load(format!("text model: {error}")))?;
        Ok(Self { tokenizer, session })
    }

    /// Token ids of one prompt: `<bos>`, the text, `<eos>`, unpadded and untruncated, as the
    /// worker's `tokenizer([text], { padding: true, truncation: true })` gives for one input
    /// (the tokenizer's `model_max_length` is 1e30).
    pub(crate) fn token_ids(&self, text: &str) -> Result<Vec<i64>, MlError> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|error| MlError::Input(format!("tokenizer: {error}")))?;
        Ok(encoding.get_ids().iter().map(|&id| i64::from(id)).collect())
    }

    /// Runs the graph on a prompt that carries no image, video or audio.
    pub(crate) fn sentence_embedding(&mut self, ids: Vec<i64>) -> Result<Vec<f32>, MlError> {
        self.sentence_embedding_with_audio(ids, Vec::new())
    }

    /// Runs the graph on a prompt whose `<|audio|>` placeholders take the rows of `audio`, the
    /// audio encoder's soft tokens.
    pub(crate) fn sentence_embedding_with_audio(
        &mut self,
        ids: Vec<i64>,
        audio: Vec<f32>,
    ) -> Result<Vec<f32>, MlError> {
        let audio_rows = audio.len() / SOFT_TOKEN_WIDTH;
        check_placeholders(&ids, audio_rows)?;
        let len = ids.len();
        let inference = |error: ort::Error| MlError::Inference(error.to_string());
        let input_ids = Tensor::from_array(([1, len], ids)).map_err(inference)?;
        let attention_mask = Tensor::from_array(([1, len], vec![1_i64; len])).map_err(inference)?;
        let no_features =
            || Tensor::from_array(([0, SOFT_TOKEN_WIDTH], Vec::<f32>::new())).map_err(inference);
        let outputs = self
            .session
            .run(ort::inputs! {
                "input_ids" => input_ids,
                "attention_mask" => attention_mask,
                "image_features" => no_features()?,
                "video_features" => no_features()?,
                "audio_features" => Tensor::from_array(([audio_rows, SOFT_TOKEN_WIDTH], audio))
                    .map_err(inference)?,
            })
            .map_err(inference)?;
        let embedding = outputs
            .get("sentence_embedding")
            .ok_or_else(|| MlError::Inference("the model returned no sentence_embedding".into()))?;
        let (_, values) = embedding.try_extract_tensor::<f32>().map_err(inference)?;
        if values.len() != SENTENCE_EMBEDDING_WIDTH {
            return Err(MlError::Inference(format!(
                "Unexpected dimension: {} (expected {SENTENCE_EMBEDDING_WIDTH})",
                values.len()
            )));
        }
        Ok(values.to_vec())
    }
}

/// The model places one soft token at each placeholder, so a prompt whose placeholders do not match
/// its features (`audio_rows` audio soft tokens, no image or video) is refused, with
/// `modeling_embedding_gemma2.js`'s message. A text such as `<|image|>` typed into a note tokenizes
/// to the placeholder and fails here as it does there.
fn check_placeholders(ids: &[i64], audio_rows: usize) -> Result<(), MlError> {
    for (modality, token_id) in PLACEHOLDERS {
        let tokens = ids.iter().filter(|&&id| id == token_id).count();
        let features = if modality == "audio" { audio_rows } else { 0 };
        if tokens != features {
            return Err(MlError::Input(format!(
                "The number of {modality} tokens ({tokens}) and {modality} features ({features}) do not match."
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_placeholder_without_features_is_refused_with_the_worker_message() {
        assert!(check_placeholders(&[2, 9259, 1], 0).is_ok());
        let error =
            check_placeholders(&[2, 258_881, 258_881, 1], 0).expect_err("audio placeholders");
        assert_eq!(
            error.to_string(),
            "The number of audio tokens (2) and audio features (0) do not match."
        );
        let error = check_placeholders(&[2, 258_884, 258_880, 1], 0).expect_err("image first");
        assert_eq!(
            error.to_string(),
            "The number of image tokens (1) and image features (0) do not match."
        );
        let audio_prompt = [2, 256_000, 258_881, 258_881, 258_883, 1];
        assert!(check_placeholders(&audio_prompt, 2).is_ok());
        let error = check_placeholders(&audio_prompt, 3).expect_err("one row too many");
        assert_eq!(
            error.to_string(),
            "The number of audio tokens (2) and audio features (3) do not match."
        );
    }
}

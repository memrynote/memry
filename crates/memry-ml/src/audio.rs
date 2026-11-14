//! The audio encoder: `audio_encoder_q4.onnx`, which turns the log-mel features of one window into
//! the soft tokens the text graph places at the prompt's `<|audio|>` placeholders.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::MlError;
use crate::audio_prep::{AudioFeatures, MEL_BINS};
use crate::files::{AUDIO_GRAPH, file_path};
use crate::runtime::session_builder;
use crate::text::SOFT_TOKEN_WIDTH;

/// The prompt `processor(null, null, audio)` builds for one clip: the clip's placeholder expanded
/// to `<|audio>`, one `<|audio|>` per soft token, `<audio|>` (the tokenizer adds `<bos>`/`<eos>`).
pub(crate) fn audio_prompt(soft_tokens: usize) -> String {
    format!("<|audio>{}<audio|>", "<|audio|>".repeat(soft_tokens))
}

pub(crate) struct AudioEncoder {
    session: Session,
}

impl AudioEncoder {
    pub(crate) fn load(dir: &Path, intra_threads: usize) -> Result<Self, MlError> {
        let session = session_builder(intra_threads)?
            .commit_from_file(file_path(dir, &AUDIO_GRAPH))
            .map_err(|error| MlError::Load(format!("audio encoder: {error}")))?;
        Ok(Self { session })
    }

    /// The soft tokens of one window, row after row of [`SOFT_TOKEN_WIDTH`] values.
    pub(crate) fn encode(&mut self, features: &AudioFeatures) -> Result<Vec<f32>, MlError> {
        let inference = |error: ort::Error| MlError::Inference(error.to_string());
        let frames = features.frames;
        let input_features = Tensor::from_array(([1, frames, MEL_BINS], features.values.clone()))
            .map_err(inference)?;
        let input_features_mask =
            Tensor::from_array(([1, frames], features.mask.clone())).map_err(inference)?;
        let outputs = self
            .session
            .run(ort::inputs! {
                "input_features" => input_features,
                "input_features_mask" => input_features_mask,
            })
            .map_err(inference)?;
        let soft_tokens = outputs.get("audio_features").ok_or_else(|| {
            MlError::Inference("the audio encoder returned no audio_features".into())
        })?;
        let (shape, values) = soft_tokens.try_extract_tensor::<f32>().map_err(inference)?;
        if shape.len() != 2 || shape[1] != SOFT_TOKEN_WIDTH as i64 {
            return Err(MlError::Inference(format!(
                "Unexpected audio_features shape {shape:?} (expected [n, {SOFT_TOKEN_WIDTH}])"
            )));
        }
        Ok(values.to_vec())
    }
}

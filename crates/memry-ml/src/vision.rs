//! The vision encoder (`vision_encoder_q4.onnx`) and the image prompt of
//! `EmbeddingGemma2Processor`: one image becomes `num_soft_tokens` rows of `image_features`, and
//! its `<|image|>` placeholder becomes `<|image>`, that many `<|image|>` and `<image|>`.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::MlError;
use crate::files::{VISION_GRAPH, file_path};
use crate::image_prep::{PATCH_DIM, PixelTensor};
use crate::runtime::session_builder;
use crate::text::SOFT_TOKEN_WIDTH;

const IMAGE_TOKEN: &str = "<|image|>";
const BOI_TOKEN: &str = "<|image>";
const EOI_TOKEN: &str = "<image|>";

/// The other placeholders of the processor; an image call passes none of their inputs.
const OTHER_TOKENS: [&str; 2] = ["<|video|>", "<|audio|>"];

pub(crate) struct VisionModel {
    session: Session,
}

impl VisionModel {
    pub(crate) fn load(dir: &Path, intra_threads: usize) -> Result<Self, MlError> {
        let session = session_builder(intra_threads)?
            .commit_from_file(file_path(dir, &VISION_GRAPH))
            .map_err(|error| MlError::Load(format!("vision encoder: {error}")))?;
        Ok(Self { session })
    }

    /// `image_features`: `num_soft_tokens` rows of [`SOFT_TOKEN_WIDTH`] values.
    pub(crate) fn image_features(&mut self, tensor: PixelTensor) -> Result<Vec<f32>, MlError> {
        let inference = |error: ort::Error| MlError::Inference(error.to_string());
        let patches = tensor.max_patches;
        let pixel_values = Tensor::from_array(([1, patches, PATCH_DIM], tensor.pixel_values))
            .map_err(inference)?;
        let position_ids =
            Tensor::from_array(([1, patches, 2], tensor.position_ids)).map_err(inference)?;
        let outputs = self
            .session
            .run(ort::inputs! {
                "pixel_values" => pixel_values,
                "pixel_position_ids" => position_ids,
            })
            .map_err(inference)?;
        let features = outputs
            .get("image_features")
            .ok_or_else(|| MlError::Inference("the encoder returned no image_features".into()))?;
        let (_, values) = features.try_extract_tensor::<f32>().map_err(inference)?;
        if values.len() != tensor.num_soft_tokens * SOFT_TOKEN_WIDTH {
            return Err(MlError::Inference(format!(
                "the encoder returned {} values for {} soft tokens",
                values.len(),
                tensor.num_soft_tokens
            )));
        }
        Ok(values.to_vec())
    }
}

/// `EmbeddingGemma2Processor` for one image: the text (or `<|image|>` alone) with its one image
/// placeholder expanded, refusing any other count and any video or audio placeholder with the
/// processor's message.
pub(crate) fn image_prompt(text: Option<&str>, num_soft_tokens: usize) -> Result<String, MlError> {
    let text = text.unwrap_or(IMAGE_TOKEN);
    let found = |token: &str, inputs: usize| {
        let count = text.matches(token).count();
        if count == inputs {
            return Ok(());
        }
        Err(MlError::Input(format!(
            "Found {count} {token} tokens in the text, but {inputs} inputs were passed."
        )))
    };
    found(IMAGE_TOKEN, 1)?;
    for token in OTHER_TOKENS {
        found(token, 0)?;
    }
    let expanded = format!(
        "{BOI_TOKEN}{}{EOI_TOKEN}",
        IMAGE_TOKEN.repeat(num_soft_tokens)
    );
    Ok(text.replacen(IMAGE_TOKEN, &expanded, 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_placeholder_expands_to_the_soft_tokens_between_image_markers() {
        assert_eq!(
            image_prompt(None, 2).expect("alone"),
            "<|image><|image|><|image|><image|>"
        );
        assert_eq!(
            image_prompt(Some("title: none | text: menu <|image|>"), 1).expect("interleaved"),
            "title: none | text: menu <|image><|image|><image|>"
        );
    }

    #[test]
    fn a_wrong_placeholder_count_is_refused_with_the_processor_message() {
        let cases = [
            (
                "no placeholder",
                "Found 0 <|image|> tokens in the text, but 1 inputs were passed.",
            ),
            (
                "<|image|> twice <|image|>",
                "Found 2 <|image|> tokens in the text, but 1 inputs were passed.",
            ),
            (
                "<|image|> <|video|>",
                "Found 1 <|video|> tokens in the text, but 0 inputs were passed.",
            ),
            (
                "<|audio|><|image|><|audio|>",
                "Found 2 <|audio|> tokens in the text, but 0 inputs were passed.",
            ),
        ];
        for (text, message) in cases {
            let error = image_prompt(Some(text), 4).expect_err(text);
            assert_eq!(error.to_string(), message);
        }
    }
}

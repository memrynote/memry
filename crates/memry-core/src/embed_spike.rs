//! Throwaway spike for #4437: on-device text embedding with ONNX Runtime.
//!
//! Not merged. Compiled only with `--features embed-spike`, which links ORT
//! statically from Microsoft's `onnxruntime-c` iOS xcframework through
//! `ORT_IOS_XCFWK_PATH`. Measures whether `ort` plus `tokenizers` build and
//! run inside the core's xcframework, and what they cost on a phone.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;
use tokenizers::Tokenizer;

// The ORT iOS archive references UIDevice and nw_path_* (Network.framework);
// ort-sys names only Foundation and CoreML, so the cdylib link needs these too.
#[cfg(target_os = "ios")]
#[link(name = "UIKit", kind = "framework")]
#[link(name = "Network", kind = "framework")]
unsafe extern "C" {}
#[cfg(target_os = "macos")]
#[link(name = "Network", kind = "framework")]
#[link(name = "CoreML", kind = "framework")]
#[link(name = "Foundation", kind = "framework")]
#[link(name = "c++")]
unsafe extern "C" {}

/// Matches desktop's `EMBEDDING_DIMENSION` (Matryoshka truncation of 768).
const DIMENSION: usize = 256;
/// Desktop's `text_config.hidden_size`, the width of the empty modality inputs.
const FEATURE_WIDTH: i64 = 512;
const MAX_INPUT_LENGTH: usize = 4000;
const MAX_CHUNKS: usize = 16;
const MAX_CHUNK_TITLE_LENGTH: usize = 200;
const MIN_TEXT_LENGTH: usize = 10;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SpikeError {
    #[error("{message}")]
    Failed { message: String },
}

fn fail(e: impl std::fmt::Display) -> SpikeError {
    SpikeError::Failed {
        message: e.to_string(),
    }
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SpikeEmbedding {
    pub vector: Vec<f32>,
    pub tokens: u32,
    pub tokenize_ms: f64,
    pub infer_ms: f64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SpikeLoadTiming {
    pub tokenizer_ms: f64,
    pub session_ms: f64,
}

#[derive(uniffi::Object)]
pub struct SpikeEmbedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    timing: SpikeLoadTiming,
}

#[uniffi::export]
impl SpikeEmbedder {
    /// Loads `tokenizer.json` and `onnx/model_q4.onnx` (+ `_data`) from `model_dir`.
    #[uniffi::constructor]
    pub fn load(model_dir: String, intra_threads: u32) -> Result<Arc<Self>, SpikeError> {
        let started = Instant::now();
        let tokenizer =
            Tokenizer::from_file(format!("{model_dir}/tokenizer.json")).map_err(fail)?;
        let tokenizer_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = Instant::now();
        let env = ort::init().with_name("memry-spike").build().map_err(fail)?;
        let session = Session::builder(&env)
            .map_err(fail)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(fail)?
            .with_intra_threads(intra_threads as usize)
            .map_err(fail)?
            .with_inter_threads(1)
            .map_err(fail)?
            .commit_from_file(format!("{model_dir}/onnx/model_q4.onnx"))
            .map_err(fail)?;
        let session_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(Arc::new(Self {
            session: Mutex::new(session),
            tokenizer,
            timing: SpikeLoadTiming {
                tokenizer_ms,
                session_ms,
            },
        }))
    }

    pub fn load_timing(&self) -> SpikeLoadTiming {
        self.timing.clone()
    }

    /// One model window, already shaped by the caller (desktop's
    /// `embedding-worker.ts` cuts at 4000 chars before tokenizing).
    pub fn embed(&self, text: String) -> Result<SpikeEmbedding, SpikeError> {
        let text: String = text.chars().take(MAX_INPUT_LENGTH).collect();
        let started = Instant::now();
        let encoding = self.tokenizer.encode(text, true).map_err(fail)?;
        let ids: Vec<i64> = encoding.get_ids().iter().map(|&i| i64::from(i)).collect();
        let mask: Vec<i64> = encoding
            .get_attention_mask()
            .iter()
            .map(|&i| i64::from(i))
            .collect();
        let tokenize_ms = started.elapsed().as_secs_f64() * 1000.0;
        let len = ids.len() as i64;

        let started = Instant::now();
        let empty = || Tensor::<f32>::from_array(([0_i64, FEATURE_WIDTH], Vec::<f32>::new()));
        let inputs = ort::inputs![
            "input_ids" => Tensor::<i64>::from_array(([1_i64, len], ids)).map_err(fail)?,
            "attention_mask" => Tensor::<i64>::from_array(([1_i64, len], mask)).map_err(fail)?,
            "image_features" => empty().map_err(fail)?,
            "video_features" => empty().map_err(fail)?,
            "audio_features" => empty().map_err(fail)?,
        ];
        let mut session = self.session.lock().map_err(fail)?;
        let outputs = session.run(inputs).map_err(fail)?;
        let (_, full) = outputs["sentence_embedding"]
            .try_extract_tensor::<f32>()
            .map_err(fail)?;
        let vector = truncate(full)?;
        let infer_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(SpikeEmbedding {
            vector,
            tokens: len as u32,
            tokenize_ms,
            infer_ms,
        })
    }
}

/// Port of desktop's `truncateEmbedding`: first 256 dims, L2 re-normalized.
fn truncate(full: &[f32]) -> Result<Vec<f32>, SpikeError> {
    if full.len() < DIMENSION {
        return Err(fail(format!("unexpected dimension {}", full.len())));
    }
    let head = &full[..DIMENSION];
    let norm = head.iter().map(|v| v * v).sum::<f32>().sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return Err(fail("embedding is not finite"));
    }
    Ok(head.iter().map(|v| v / norm).collect())
}

/// Port of desktop's `buildEmbeddingChunks` for the corpus-cost run only.
/// Lengths count UTF-16 units as JS does; the corpus is ASCII so chars == units.
#[uniffi::export]
pub fn spike_embedding_chunks(title: String, content: String) -> Vec<String> {
    let title = title.trim();
    let content = content.trim();
    if title.len() + content.len() < MIN_TEXT_LENGTH {
        return Vec::new();
    }
    let short_title: String = title.chars().take(MAX_CHUNK_TITLE_LENGTH).collect();
    let header = format!(
        "title: {} | text: ",
        if short_title.is_empty() {
            "none"
        } else {
            &short_title
        }
    );
    let budget = MAX_INPUT_LENGTH - header.len();
    let mut pieces: Vec<String> = Vec::new();
    let mut rest = content.to_string();
    while pieces.len() < MAX_CHUNKS {
        if rest.len() <= budget {
            pieces.push(rest);
            break;
        }
        let cut = find_cut(&rest, budget);
        pieces.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim().to_string();
    }
    pieces
        .into_iter()
        .enumerate()
        .filter(|(i, p)| *i == 0 || p.len() >= MIN_TEXT_LENGTH)
        .map(|(_, p)| format!("{header}{p}"))
        .collect()
}

fn find_cut(text: &str, budget: usize) -> usize {
    let window = &text[..budget];
    for sep in ["\n\n", "\n", ". ", " "] {
        if let Some(at) = window.rfind(sep)
            && 2 * at >= budget
        {
            return at + sep.len();
        }
    }
    budget
}

//! Text to vector: desktop's embeddinggemma q4 graph through ONNX Runtime,
//! truncated to 256 dimensions exactly as desktop's `truncateEmbedding` does.

use std::path::Path;
use std::sync::Arc;

use super::SemanticError;

/// Desktop's `EMBEDDING_DIMENSION`, the Matryoshka truncation of the model's 768.
pub const DIMENSION: usize = 256;

/// Unit length and finite by construction, so cosine is a dot product.
#[derive(Debug, Clone, PartialEq)]
pub struct Vector([f32; DIMENSION]);

impl Vector {
    pub fn dot(&self, other: &Vector) -> f32 {
        self.0.iter().zip(&other.0).map(|(a, b)| a * b).sum()
    }

    pub fn to_le_bytes(&self) -> [u8; DIMENSION * 4] {
        let mut bytes = [0; DIMENSION * 4];
        for (chunk, value) in bytes.as_chunks_mut::<4>().0.iter_mut().zip(&self.0) {
            *chunk = value.to_le_bytes();
        }
        bytes
    }

    pub fn from_le_bytes(bytes: &[u8]) -> Option<Vector> {
        let (chunks, []) = bytes.as_chunks::<4>() else {
            return None;
        };
        if chunks.len() != DIMENSION {
            return None;
        }
        let mut values = [0.0; DIMENSION];
        for (value, chunk) in values.iter_mut().zip(chunks) {
            *value = f32::from_le_bytes(*chunk);
            if !value.is_finite() {
                return None;
            }
        }
        Some(Vector(values))
    }
}

/// Desktop's `truncateEmbedding`: the first 256 dimensions, L2-renormalised.
pub fn truncate_renormalize(full: &[f32]) -> Result<Vector, SemanticError> {
    let head: [f32; DIMENSION] = full
        .get(..DIMENSION)
        .and_then(|head| head.try_into().ok())
        .ok_or_else(|| SemanticError::inference(format!("{} dimensions", full.len())))?;
    let norm = head.iter().map(|v| v * v).sum::<f32>().sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return Err(SemanticError::inference("embedding is not finite"));
    }
    Ok(Vector(head.map(|v| v / norm)))
}

/// Intra-op threads are fixed when the session is built, so switching costs
/// one reload (about 1.4 s on an A14).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Threads {
    Foreground,
    Background,
}

impl Threads {
    pub fn intra_op(self) -> usize {
        match self {
            Threads::Foreground => 2,
            Threads::Background => 1,
        }
    }
}

/// `input` is one shaped model window of at most 4000 UTF-16 units.
pub trait Embed: Send + Sync {
    fn threads(&self) -> Threads;
    fn embed(&self, input: &str) -> Result<Vector, SemanticError>;
    /// `None` while another call holds the session, so a query never waits
    /// behind a corpus window.
    fn try_embed(&self, input: &str) -> Result<Option<Vector>, SemanticError>;
}

/// Loads `tokenizer.json` and `onnx/model_q4.onnx` (with its `_data` beside
/// it) from `dir`, and checks the graph's input and output names before
/// returning. Without the `semantic` feature this is always `Unavailable`.
pub fn load(dir: &Path, threads: Threads) -> Result<Arc<dyn Embed>, SemanticError> {
    #[cfg(feature = "semantic")]
    {
        Ok(Arc::new(onnx::OnnxEmbedder::load(dir, threads)?))
    }
    #[cfg(not(feature = "semantic"))]
    {
        let _ = (dir, threads);
        Err(SemanticError::Unavailable)
    }
}

#[cfg(feature = "semantic")]
mod onnx {
    use std::path::Path;
    use std::sync::{Mutex, OnceLock, TryLockError};

    use ort::environment::Environment;
    use ort::session::Session;
    use ort::session::builder::GraphOptimizationLevel;
    use ort::value::Tensor;
    use tokenizers::Tokenizer;

    use super::{Embed, SemanticError, Threads, Vector, truncate_renormalize};

    // ort-sys names only Foundation and CoreML. The iOS archive also references
    // UIDevice and nw_path_*, and the macOS slice (the host parity run) needs
    // all of these, so the cdylib and test links name them.
    #[cfg(target_os = "ios")]
    #[link(name = "UIKit", kind = "framework")]
    unsafe extern "C" {}
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    #[link(name = "Network", kind = "framework")]
    unsafe extern "C" {}
    #[cfg(target_os = "macos")]
    #[link(name = "CoreML", kind = "framework")]
    unsafe extern "C" {}
    #[cfg(target_os = "macos")]
    #[link(name = "Foundation", kind = "framework")]
    unsafe extern "C" {}
    #[cfg(target_os = "macos")]
    #[link(name = "c++")]
    unsafe extern "C" {}

    const INPUTS: [&str; 5] = [
        "input_ids",
        "attention_mask",
        "image_features",
        "video_features",
        "audio_features",
    ];
    const OUTPUT: &str = "sentence_embedding";
    /// `text_config.hidden_size`, the width of the empty modality inputs.
    const FEATURE_WIDTH: i64 = 512;

    /// `ort` allows one environment per process for the process's lifetime,
    /// so a reload must reuse it.
    fn environment() -> Result<&'static Environment, SemanticError> {
        static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();
        ENV.get_or_init(|| {
            ort::init()
                .with_name("memry")
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(SemanticError::inference)
    }

    fn build_session(env: &Environment, dir: &Path, threads: Threads) -> ort::Result<Session> {
        Session::builder(env)?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(threads.intra_op())?
            .with_inter_threads(1)?
            .commit_from_file(dir.join("onnx/model_q4.onnx"))
    }

    pub(super) struct OnnxEmbedder {
        session: Mutex<Session>,
        tokenizer: Tokenizer,
        threads: Threads,
    }

    impl OnnxEmbedder {
        pub(super) fn load(dir: &Path, threads: Threads) -> Result<Self, SemanticError> {
            let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
                .map_err(SemanticError::inference)?;
            let session =
                build_session(environment()?, dir, threads).map_err(SemanticError::inference)?;
            let mut inputs: Vec<&str> = session.inputs().iter().map(|i| i.name()).collect();
            inputs.sort_unstable();
            let mut expected = INPUTS;
            expected.sort_unstable();
            if inputs != expected || !session.outputs().iter().any(|o| o.name() == OUTPUT) {
                return Err(SemanticError::inference(format!(
                    "unexpected graph: inputs {inputs:?}"
                )));
            }
            Ok(Self {
                session: Mutex::new(session),
                tokenizer,
                threads,
            })
        }

        fn tokenize(&self, input: &str) -> Result<(Vec<i64>, Vec<i64>), SemanticError> {
            let encoding = self
                .tokenizer
                .encode(input, true)
                .map_err(SemanticError::inference)?;
            let ids = encoding.get_ids().iter().map(|&i| i64::from(i)).collect();
            let mask = encoding
                .get_attention_mask()
                .iter()
                .map(|&i| i64::from(i))
                .collect();
            Ok((ids, mask))
        }
    }

    fn run(session: &mut Session, ids: Vec<i64>, mask: Vec<i64>) -> Result<Vector, SemanticError> {
        let shape = [1, ids.len() as i64];
        let empty = || Tensor::<f32>::from_array(([0, FEATURE_WIDTH], Vec::<f32>::new()));
        let inputs = ort::inputs![
            "input_ids" => Tensor::from_array((shape, ids)).map_err(SemanticError::inference)?,
            "attention_mask" => Tensor::from_array((shape, mask)).map_err(SemanticError::inference)?,
            "image_features" => empty().map_err(SemanticError::inference)?,
            "video_features" => empty().map_err(SemanticError::inference)?,
            "audio_features" => empty().map_err(SemanticError::inference)?,
        ];
        let outputs = session.run(inputs).map_err(SemanticError::inference)?;
        let (_, full) = outputs[OUTPUT]
            .try_extract_tensor::<f32>()
            .map_err(SemanticError::inference)?;
        truncate_renormalize(full)
    }

    impl Embed for OnnxEmbedder {
        fn threads(&self) -> Threads {
            self.threads
        }

        fn embed(&self, input: &str) -> Result<Vector, SemanticError> {
            let (ids, mask) = self.tokenize(input)?;
            let mut session = self.session.lock().map_err(|_| SemanticError::Poisoned)?;
            run(&mut session, ids, mask)
        }

        fn try_embed(&self, input: &str) -> Result<Option<Vector>, SemanticError> {
            let mut session = match self.session.try_lock() {
                Ok(session) => session,
                Err(TryLockError::WouldBlock) => return Ok(None),
                Err(TryLockError::Poisoned(_)) => return Err(SemanticError::Poisoned),
            };
            let (ids, mask) = self.tokenize(input)?;
            run(&mut session, ids, mask).map(Some)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(index: usize) -> Vector {
        let mut full = [0.0; DIMENSION];
        full[index] = 3.0;
        truncate_renormalize(&full).expect("finite")
    }

    #[test]
    fn truncation_keeps_the_head_and_renormalises() {
        let full: Vec<f32> = (0..768)
            .map(|i| if i < DIMENSION { 2.0 } else { 9.0 })
            .collect();
        let vector = truncate_renormalize(&full).expect("768 finite dims");
        assert!((vector.dot(&vector) - 1.0).abs() < 1e-6);
        let expected = 1.0 / (DIMENSION as f32).sqrt();
        assert!(vector.0.iter().all(|v| (v - expected).abs() < 1e-6));
    }

    #[test]
    fn truncation_rejects_short_zero_and_non_finite_input() {
        assert!(truncate_renormalize(&[1.0; DIMENSION - 1]).is_err());
        assert!(truncate_renormalize(&[0.0; DIMENSION]).is_err());
        let mut nan = [1.0; DIMENSION];
        nan[7] = f32::NAN;
        assert!(truncate_renormalize(&nan).is_err());
        let mut inf = [1.0; DIMENSION];
        inf[0] = f32::INFINITY;
        assert!(truncate_renormalize(&inf).is_err());
    }

    #[test]
    fn bytes_round_trip_and_reject_the_wrong_length() {
        let full: Vec<f32> = (0..DIMENSION).map(|i| (i as f32 * 0.37).sin()).collect();
        let vector = truncate_renormalize(&full).expect("finite");
        let bytes = vector.to_le_bytes();
        assert_eq!(Vector::from_le_bytes(&bytes), Some(vector));
        assert_eq!(Vector::from_le_bytes(&bytes[..1020]), None);
        assert_eq!(
            Vector::from_le_bytes(&[bytes.as_slice(), &[0; 4]].concat()),
            None
        );
        let mut nan = bytes;
        nan[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(Vector::from_le_bytes(&nan), None);
    }

    #[test]
    fn dot_of_unit_vectors_is_cosine() {
        assert_eq!(unit(3).dot(&unit(3)), 1.0);
        assert_eq!(unit(3).dot(&unit(4)), 0.0);
    }

    #[cfg(not(feature = "semantic"))]
    #[test]
    fn load_without_the_feature_is_unavailable() {
        assert!(matches!(
            load(Path::new("/nonexistent"), Threads::Foreground),
            Err(SemanticError::Unavailable)
        ));
    }
}

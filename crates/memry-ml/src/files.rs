//! The pinned model files and where they live on disk.
//!
//! The layout is the one transformers.js writes under Electron's `embeddingModelCacheDir`
//! (`apps/desktop/src/main/lib/embeddings-constants.ts`), so the files an Electron profile already
//! downloaded are reused once their size and hash match.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::MlError;

/// Hugging Face repository of the model.
pub const MODEL_REPO: &str = "onnx-community/embeddinggemma-2-ONNX";

/// Revision every file below is pinned to.
pub const MODEL_REVISION: &str = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

/// One file of the pinned revision, `path` relative to the model directory with `/` separators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelFile {
    pub path: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub(crate) const TOKENIZER: ModelFile = ModelFile {
    path: "tokenizer.json",
    size: 32_170_510,
    sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
};
pub(crate) const TEXT_GRAPH: ModelFile = ModelFile {
    path: "onnx/model_q4.onnx",
    size: 490_742,
    sha256: "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9",
};
const TEXT_WEIGHTS: ModelFile = ModelFile {
    path: "onnx/model_q4.onnx_data",
    size: 174_028_800,
    sha256: "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49",
};
const VISION_GRAPH: ModelFile = ModelFile {
    path: "onnx/vision_encoder_q4.onnx",
    size: 159_400,
    sha256: "7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96",
};
const VISION_WEIGHTS: ModelFile = ModelFile {
    path: "onnx/vision_encoder_q4.onnx_data",
    size: 108_957_696,
    sha256: "0a9d6c927334f152a33dd90874f65d6ea5228999abe6a450d3f7813677fa704c",
};
const AUDIO_GRAPH: ModelFile = ModelFile {
    path: "onnx/audio_encoder_q4.onnx",
    size: 245_543,
    sha256: "c4cce3370e72262280d00293cac038896050a03a8e9a27e10b061ca97510296e",
};
const AUDIO_WEIGHTS: ModelFile = ModelFile {
    path: "onnx/audio_encoder_q4.onnx_data",
    size: 189_075_968,
    sha256: "ba9328e6341360974083085b44b2bba265003bda564740f7c4c23ed9928f17e2",
};

/// Files that download and load together: the text group is needed for any embedding, the
/// encoders only for their first image or recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelGroup {
    Text,
    Vision,
    Audio,
}

impl ModelGroup {
    pub fn files(self) -> &'static [ModelFile] {
        match self {
            Self::Text => &[TOKENIZER, TEXT_GRAPH, TEXT_WEIGHTS],
            Self::Vision => &[VISION_GRAPH, VISION_WEIGHTS],
            Self::Audio => &[AUDIO_GRAPH, AUDIO_WEIGHTS],
        }
    }
}

/// `<app_data>/models/transformers/onnx-community/embeddinggemma-2-ONNX`.
pub fn model_dir(app_data: &Path) -> PathBuf {
    let mut dir = app_data.join("models").join("transformers");
    dir.extend(MODEL_REPO.split('/'));
    dir
}

pub(crate) fn file_path(dir: &Path, file: &ModelFile) -> PathBuf {
    let mut path = dir.to_path_buf();
    path.extend(file.path.split('/'));
    path
}

/// Checks the size of every file of `group`: what a load needs before it reads the weights.
pub(crate) fn ensure_present(dir: &Path, group: ModelGroup) -> Result<(), MlError> {
    for file in group.files() {
        let size = std::fs::metadata(file_path(dir, file))
            .map(|meta| meta.len())
            .ok();
        if size != Some(file.size) {
            return Err(MlError::ModelMissing(file.path.to_owned()));
        }
    }
    Ok(())
}

/// Checks the size and SHA-256 of every file of `group`. Reads the whole group (207 MB for text),
/// so it runs after a download, not before every load.
pub fn verify(dir: &Path, group: ModelGroup) -> Result<(), MlError> {
    ensure_present(dir, group)?;
    for file in group.files() {
        let digest = sha256_file(&file_path(dir, file))
            .map_err(|_| MlError::ModelMissing(file.path.to_owned()))?;
        if digest != file.sha256 {
            return Err(MlError::ModelMissing(file.path.to_owned()));
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut reader = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_dir_is_the_transformers_js_cache_layout() {
        let dir = model_dir(Path::new("app"));
        let expected: PathBuf = [
            "app",
            "models",
            "transformers",
            "onnx-community",
            "embeddinggemma-2-ONNX",
        ]
        .iter()
        .collect();
        assert_eq!(dir, expected);
        let weights: PathBuf = expected.join("onnx").join("model_q4.onnx_data");
        assert_eq!(file_path(&dir, &TEXT_WEIGHTS), weights);
    }

    /// A file of the right size whose bytes differ is caught only by the hash, which is what a
    /// torn or tampered download looks like.
    #[test]
    fn verify_rejects_missing_short_and_wrong_files() {
        let dir = tempfile::Builder::new()
            .prefix("memry-ml-files")
            .tempdir()
            .expect("tempdir");
        let root = dir.path();
        let graph = file_path(root, &VISION_GRAPH);
        std::fs::create_dir_all(graph.parent().expect("parent")).expect("mkdir");

        let missing = verify(root, ModelGroup::Vision).expect_err("empty dir");
        assert!(matches!(missing, MlError::ModelMissing(ref path) if path == VISION_GRAPH.path));

        std::fs::write(&graph, vec![0u8; 10]).expect("write");
        let short = verify(root, ModelGroup::Vision).expect_err("short graph");
        assert!(matches!(short, MlError::ModelMissing(ref path) if path == VISION_GRAPH.path));

        std::fs::write(&graph, vec![0u8; VISION_GRAPH.size as usize]).expect("write");
        let weights = file_path(root, &VISION_WEIGHTS);
        File::create(&weights)
            .and_then(|f| f.set_len(VISION_WEIGHTS.size))
            .expect("sparse weights");
        assert!(ensure_present(root, ModelGroup::Vision).is_ok());
        let wrong = verify(root, ModelGroup::Vision).expect_err("zero bytes");
        assert!(matches!(wrong, MlError::ModelMissing(ref path) if path == VISION_GRAPH.path));
    }
}

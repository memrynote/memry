//! The embedding ops on `memry-ml` (EmbeddingGemma 2 on a statically linked ONNX Runtime), out of
//! the app's process as Electron's embedding utility process runs them (Kaan, 2026-11-14): a crash
//! in ONNX Runtime ends this child, never the app. The model loads on the first embedding op from
//! its repo's directory under `--model-cache`, the transformers.js cache layout. The app downloads the files and checks their SHA-256 once per session before it
//! asks for a load; the load here checks their sizes only (`EmbeddingEngine::load`).

use std::path::PathBuf;

use memry_ml::{EmbeddingEngine, LoadOptions, MlError};
use memry_ml_worker::{Manifest, ManifestFile, ModelGroup, Request, Response};

const _: () = assert!(memry_ml::EMBEDDING_DIMENSION == memry_ml_worker::EMBEDDING_DIMENSION);
const _: () =
    assert!(memry_ml::image_prep::MAX_IMAGE_BYTES == memry_ml_worker::MAX_EMBED_IMAGE_BYTES);

pub struct Embedder {
    dir: Option<PathBuf>,
    engine: Option<EmbeddingEngine>,
}

impl Embedder {
    pub fn new(cache: Option<PathBuf>) -> Self {
        let dir = cache.map(|mut dir| {
            dir.extend(memry_ml::MODEL_REPO.split('/'));
            dir
        });
        Self { dir, engine: None }
    }

    pub fn handle(&mut self, request: Request) -> Response {
        let outcome = match request {
            Request::ModelManifest { group } => Ok(Response::Manifest(manifest(group))),
            Request::EmbedLoad => self.engine().map(|_| Response::Done),
            Request::EmbedText { text } => self
                .engine()
                .and_then(|engine| engine.embed_text(&text).map_err(|e| e.to_string()))
                .map(|values| Response::Embedded(values.to_vec())),
            Request::EmbedImage {
                bytes,
                text,
                soft_tokens,
            } => self
                .engine()
                .and_then(|engine| {
                    engine
                        .embed_image(&bytes, text.as_deref(), soft_tokens.map(|n| n as usize))
                        .map_err(|e| e.to_string())
                })
                .map(|values| Response::Embedded(values.to_vec())),
            other => Err(format!("{} is not an embedding op", other.name())),
        };
        outcome.unwrap_or_else(Response::Failed)
    }

    fn engine(&mut self) -> Result<&mut EmbeddingEngine, String> {
        let engine = match &mut self.engine {
            Some(engine) => engine,
            empty => {
                let dir = self.dir.as_ref().ok_or("the worker has no --model-cache")?;
                let loaded = EmbeddingEngine::load(dir, LoadOptions::default())
                    .map_err(|error: MlError| error.to_string())?;
                empty.insert(loaded)
            }
        };
        Ok(engine)
    }
}

fn manifest(group: ModelGroup) -> Manifest {
    let group = match group {
        ModelGroup::Text => memry_ml::ModelGroup::Text,
        ModelGroup::Vision => memry_ml::ModelGroup::Vision,
        ModelGroup::Audio => memry_ml::ModelGroup::Audio,
    };
    Manifest {
        repo: memry_ml::MODEL_REPO.into(),
        revision: memry_ml::MODEL_REVISION.into(),
        files: group
            .files()
            .iter()
            .map(|file| ManifestFile {
                path: file.path.into(),
                size: file.size,
                sha256: file.sha256.into(),
            })
            .collect(),
    }
}

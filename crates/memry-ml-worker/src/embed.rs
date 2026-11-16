//! The embedding ops on `memry-ml` (EmbeddingGemma 2 on a statically linked ONNX Runtime), out of
//! the app's process as Electron's embedding utility process runs them (Kaan, 2026-11-14): a crash
//! in ONNX Runtime ends this child, never the app. The model loads on the first embedding op from
//! its repo's directory under `--model-cache`, the transformers.js cache layout. The app downloads the files and checks their SHA-256 once per session before it
//! asks for a load; the load here checks their sizes only (`EmbeddingEngine::load`).
//!
//! A recording is a vault file, untrusted: it is read here, never past
//! [`memry_ml_worker::MAX_AUDIO_BYTES`] (checked from its size before the read), decoded by
//! `memry_ml::decode_wav`, and kept as the one open recording, so a stale one never piles up next
//! to the next. Each `EmbedAudioWindow` embeds one of its 30 s windows; the audio group loads with
//! the first. Errors name no path: a voice memo's name is the user's.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use memry_ml::{EmbeddingEngine, LoadOptions, MlError};
use memry_ml_worker::{Manifest, ManifestFile, ModelGroup, Request, Response};

const _: () = assert!(memry_ml::EMBEDDING_DIMENSION == memry_ml_worker::EMBEDDING_DIMENSION);
const _: () =
    assert!(memry_ml::image_prep::MAX_IMAGE_BYTES == memry_ml_worker::MAX_EMBED_IMAGE_BYTES);
const _: () = assert!(memry_ml::MAX_AUDIO_BYTES == memry_ml_worker::MAX_AUDIO_BYTES);
const _: () = assert!(memry_ml::MAX_WINDOWS == memry_ml_worker::MAX_AUDIO_WINDOWS as usize);
// The app refuses a manifest of any other repo or revision.
const _: () = assert!(same(memry_ml::MODEL_REPO, memry_ml_worker::MODEL_REPO));
const _: () = assert!(same(
    memry_ml::MODEL_REVISION,
    memry_ml_worker::MODEL_REVISION
));

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

pub struct Embedder {
    dir: Option<PathBuf>,
    engine: Option<EmbeddingEngine>,
    /// The open recording's number and its 16 kHz mono samples.
    recording: Option<(u32, Vec<f32>)>,
    next_recording: u32,
}

impl Embedder {
    pub fn new(cache: Option<PathBuf>) -> Self {
        let dir = cache.map(|mut dir| {
            dir.extend(memry_ml::MODEL_REPO.split('/'));
            dir
        });
        Self {
            dir,
            engine: None,
            recording: None,
            next_recording: 0,
        }
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
            } => self.engine().and_then(|engine| {
                match engine.embed_image(&bytes, text.as_deref(), soft_tokens.map(|n| n as usize)) {
                    Ok(values) => Ok(Response::Embedded(values.to_vec())),
                    Err(MlError::Input(message)) => Ok(Response::Rejected(message)),
                    Err(error) => Err(error.to_string()),
                }
            }),
            Request::AudioOpen { path } => self.open_audio(Path::new(&path)),
            Request::EmbedAudioWindow { recording, window } => {
                self.embed_audio_window(recording, window)
            }
            Request::AudioClose { recording } => {
                if self
                    .recording
                    .as_ref()
                    .is_some_and(|(open, _)| *open == recording)
                {
                    self.recording = None;
                }
                Ok(Response::Done)
            }
            other => Err(format!("{} is not an embedding op", other.name())),
        };
        outcome.unwrap_or_else(Response::Failed)
    }

    fn open_audio(&mut self, path: &Path) -> Result<Response, String> {
        // The previous recording's samples go before the next file is read.
        self.recording = None;
        let samples = memry_ml::decode_wav(&read_recording(path)?).map_err(|e| e.to_string())?;
        let windows = memry_ml::audio_windows(&samples).len();
        self.next_recording = self.next_recording.wrapping_add(1);
        self.recording = Some((self.next_recording, samples));
        Ok(Response::AudioOpened {
            recording: self.next_recording,
            windows: u32::try_from(windows).map_err(|_| "too many audio windows")?,
        })
    }

    fn embed_audio_window(&mut self, recording: u32, window: u32) -> Result<Response, String> {
        let Some((_, samples)) = self.recording.take_if(|(open, _)| *open == recording) else {
            return Err(format!("recording {recording} is not open"));
        };
        let outcome = match memry_ml::audio_windows(&samples).get(window as usize) {
            Some(samples) => self.engine().and_then(|engine| {
                engine
                    .embed_audio(samples)
                    .map_err(|error| error.to_string())
            }),
            None => Err(format!("recording {recording} has no window {window}")),
        };
        self.recording = Some((recording, samples));
        outcome.map(|values| Response::Embedded(values.to_vec()))
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

/// The file's bytes, refused from its size before any is read when it is over the cap. Only a
/// regular file is opened: a FIFO would block the open past the op timeout. Exactly the stat'ed
/// length is read, and a file that changed since is refused.
fn read_recording(path: &Path) -> Result<Vec<u8>, String> {
    let cap = memry_ml_worker::MAX_AUDIO_BYTES;
    let unreadable = |error: std::io::Error| format!("the recording could not be read: {error}");
    let not_regular = || "the recording is not a regular file".to_owned();
    if !std::fs::metadata(path).map_err(unreadable)?.is_file() {
        return Err(not_regular());
    }
    let mut file = File::open(path).map_err(unreadable)?;
    let metadata = file.metadata().map_err(unreadable)?;
    if !metadata.is_file() {
        return Err(not_regular());
    }
    let len = metadata.len();
    if len > cap as u64 {
        return Err(format!(
            "the recording of {len} bytes is over the {cap}-byte cap"
        ));
    }
    let mut bytes = vec![0; len as usize];
    file.read_exact(&mut bytes).map_err(unreadable)?;
    if file.read(&mut [0]).map_err(unreadable)? != 0 {
        return Err("the recording changed while it was read".to_owned());
    }
    Ok(bytes)
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

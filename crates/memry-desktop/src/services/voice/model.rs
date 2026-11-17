//! The local Whisper model: its status and its download. Electron downloads `Xenova/whisper-small`
//! through transformers.js (`voice-transcription-worker.ts`) and writes the marker
//! `whisper-small.json` once it loads. This app runs whisper.cpp, which reads one ggml file, so
//! it downloads `ggml-small.bin` at a pinned revision and writes its own marker `ggml-small.json`
//! last. Electron's marker alone never counts as downloaded; it is ignored and never deleted.
//!
//! The file is fetched by the embedding model's [`ModelSource`]: size and SHA-256 checked before
//! use, the `.part` resumed with a `Range` request, a file that fails its hash removed.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::engine::LocalEngine;
use crate::embedding::download::{Abort, DownloadError, HUB_HOST, ModelSource, PinnedFile};
use crate::embedding::service::{ModelProgress, Phase};

/// `MODEL_NAME` (voice-model.ts:19).
pub const MODEL_NAME: &str = "Whisper Small";
pub const REPO: &str = "ggerganov/whisper.cpp";
pub const REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
pub const FILE: &str = "ggml-small.bin";
/// The hub's `x-linked-size` and `x-linked-etag` of the file at [`REVISION`]: the multilingual
/// small model, which covers the 99 language codes of the settings.
pub const SIZE: u64 = 487_601_967;
pub const SHA256: &str = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const MARKER: &str = "ggml-small.json";
const MARKER_MODEL: &str = "ggml-small";
/// A hang guard for the whole download (about 490 MB), not a speed bound.
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(4 * 60 * 60);

/// `VoiceModelStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelStatus {
    pub name: String,
    pub downloaded: bool,
    pub loaded: bool,
    pub loading: bool,
    pub error: Option<String>,
}

pub struct VoiceModel {
    source: ModelSource,
    pin: PinnedFile,
    downloading: AtomicBool,
    /// Ends a download in flight: the app quits.
    cancel: CancellationToken,
    /// The last download's failure, cleared by the next success.
    error: Mutex<Option<String>>,
}

impl VoiceModel {
    /// The model under `<app-data>/models/voice-transcription/`, Electron's marker folder.
    pub fn new(data_dir: &Path) -> Self {
        Self::from_host(HUB_HOST, model_dir(data_dir), SIZE, SHA256)
    }

    /// A model served from `host` with another pin: tests serve a small file from a local fake.
    pub fn from_host(host: &str, dir: PathBuf, size: u64, sha256: &str) -> Self {
        let file = PinnedFile {
            path: FILE.to_owned(),
            size,
            sha256: sha256.to_owned(),
        };
        Self {
            source: ModelSource::new(host, REPO, REVISION, dir, vec![file.clone()]),
            pin: file,
            downloading: AtomicBool::new(false),
            cancel: CancellationToken::new(),
            error: Mutex::new(None),
        }
    }

    pub fn model_path(&self) -> PathBuf {
        self.source.dir().join(FILE)
    }

    fn marker_path(&self) -> PathBuf {
        self.source.dir().join(MARKER)
    }

    /// The marker and the model file of the pinned size are both there. A marker left after
    /// the file was removed or cut does not count.
    pub fn downloaded(&self) -> bool {
        self.marker_path().is_file()
            && fs::metadata(self.model_path()).is_ok_and(|meta| meta.len() == self.pin.size)
    }

    /// `getVoiceModelStatus`: `loaded` while the worker that loaded the model runs, `loading`
    /// during the download and the load, and the engine's last failure before the download's.
    pub fn status(&self, engine: &LocalEngine) -> VoiceModelStatus {
        VoiceModelStatus {
            name: MODEL_NAME.to_owned(),
            downloaded: self.downloaded(),
            loaded: engine.loaded(),
            loading: self.downloading.load(Ordering::SeqCst) || engine.loading(),
            error: engine.error().or_else(|| {
                self.error
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone()
            }),
        }
    }

    /// `downloadVoiceModel`: fetches and verifies the file, then writes the marker, reporting
    /// Electron's progress phases (`downloading`, `loading` at 95, then `ready` or `error`).
    pub async fn download(
        &self,
        progress: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<(), DownloadError> {
        self.downloading.store(true, Ordering::SeqCst);
        let abort = Abort {
            cancel: self.cancel.clone(),
            deadline: Instant::now() + DOWNLOAD_DEADLINE,
        };
        let renamed = |event: ModelProgress| progress(voice_progress(event));
        let outcome = match self.source.ensure(&abort, &renamed).await {
            Ok(()) => self.write_marker().map_err(|source| DownloadError::Io {
                file: MARKER.to_owned(),
                source,
            }),
            Err(error) => Err(error),
        };
        self.downloading.store(false, Ordering::SeqCst);
        let mut last_error = self.error.lock().unwrap_or_else(PoisonError::into_inner);
        match &outcome {
            Ok(()) => {
                *last_error = None;
                progress(ModelProgress::new(
                    Phase::Ready,
                    100,
                    format!("{MODEL_NAME} ready"),
                ));
            }
            Err(error) => {
                tracing::warn!(scope = "Voice", "the voice model download failed: {error}");
                *last_error = Some(error.to_string());
                progress(ModelProgress::new(Phase::Error, 0, error.to_string()));
            }
        }
        outcome
    }

    /// Cancels a download in flight and every later one (the `.part` stays for the next run).
    pub fn stop(&self) {
        self.cancel.cancel();
    }

    /// `{model, sha256, downloadedAt}`, through a temp file so a crash never leaves half a
    /// marker.
    fn write_marker(&self) -> io::Result<()> {
        let marker = serde_json::json!({
            "model": MARKER_MODEL,
            "sha256": self.pin.sha256,
            "downloadedAt": chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        let path = self.marker_path();
        let mut temp = path.clone().into_os_string();
        temp.push(".tmp");
        fs::write(&temp, marker.to_string())?;
        fs::rename(&temp, &path)
    }
}

pub fn model_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("models").join("voice-transcription")
}

/// The download's progress in Electron's voice wording (`voice-transcription-worker.ts:107-119`).
fn voice_progress(event: ModelProgress) -> ModelProgress {
    let status = match event.phase {
        Phase::Downloading => format!("Downloading {MODEL_NAME}..."),
        Phase::Loading => format!("Finalizing {MODEL_NAME}..."),
        Phase::Ready | Phase::Error => event.status,
    };
    ModelProgress::new(event.phase, event.progress, status)
}

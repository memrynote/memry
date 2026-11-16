//! The app's [`ModelLoader`]: EmbeddingGemma 2 runs in the `memry-ml-worker` sidecar, on its own
//! [`Supervisor`] (Kaan, 2026-11-14: ONNX Runtime runs out of process, as Electron's embedding
//! utility process does). A native crash ends the child and fails only the calls waiting on it,
//! as [`EmbedError::Crashed`], which the service counts toward its breaker (five in a row stop the
//! model for the session); the next load starts a new child, within the supervisor's crash bound
//! (three in a row pause it for ten minutes). The child exits 30 s after its last call, as
//! Electron's `IDLE_SHUTDOWN_MS`. Each unexpected exit is logged as Electron's `worker_exit_<phase>`
//! (`apps/desktop/src/main/lib/embeddings.ts:715-755`). The child runs at the lowest process
//! priority, so ONNX Runtime's intra-op threads yield to the app as well.
//!
//! The app owns the files: the worker names memry-ml's pins (the `ModelManifest` op), which the
//! app checks against its own repo and revision ([`MODEL_REPO`], [`MODEL_REVISION`]) and for shape,
//! downloads with one [`ModelSource`] for the whole app session (so the
//! 207 MB hash runs once), and only then asks the worker to load them. The worker never writes to
//! the model directory and checks the sizes alone.
//!
//! Audio (`embedAudio`, `apps/desktop/src/main/lib/audio-embedding.ts`): the first recording
//! downloads the audio group (189 MB) the same way, on the caller's thread, with no progress event
//! (the settings UI shows the text model's), then the worker reads and decodes the WAV file itself
//! and embeds it one 30 s window per op, so neither the file nor its samples cross the pipe. A
//! crash or a timeout on any window is [`EmbedError::Crashed`] and a window the encoder fails
//! (its files missing or broken) [`EmbedError::Failed`], both counted by the service's audio
//! breaker only; a file the worker cannot open or decode is [`EmbedError::Input`] and counts
//! nowhere.
//!
//! Images (`embedImage`): the first image downloads the vision group (about 109 MB) the same way,
//! then each image or rendered page crosses the pipe in one op (at most 30 MiB). A failure of that
//! op counts toward the service's vision breaker, as Electron's `embed-image` errors do, except an
//! image the worker cannot decode or an input it refuses ([`WorkerError::Rejected`]): that is
//! [`EmbedError::Input`] and counts nowhere, so one corrupt image never stops the others. A
//! departure from Electron, which counts it (Kaan, 9 Nov).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use memry_ml_worker::{
    AudioRecording, ExitObserver, Limits, MODEL_REPO, MODEL_REVISION, Manifest, ModelGroup,
    Supervisor, SystemClock, WorkerError,
};
use tokio::runtime::Handle;

use super::download::{Abort, HUB_HOST, ModelSource, PinnedFile};
use super::service::{AudioOpened, EmbedError, Engine, ImageInput, ModelLoader, ModelProgress};
use crate::services::file_text::WorkerPaths;
use crate::session::Session;
use crate::telemetry::events::Metrics;
use crate::telemetry::main_warning::Level;
use crate::telemetry::service::Service;

/// The most files a model group has; a manifest listing more is refused.
const MAX_FILES: usize = 16;
/// Larger than any pinned file (the audio weights are 189 MB).
const MAX_FILE_SIZE: u64 = 2 << 30;

pub struct WorkerModel(Arc<Shared>);

/// What the loader and the engines it hands out share.
struct Shared {
    supervisor: Supervisor,
    /// `<app data>/models/transformers`, the transformers.js cache root of Electron.
    cache: PathBuf,
    runtime: Handle,
    /// Built from each group's first manifest and kept for the app session.
    text: OnceLock<ModelSource>,
    audio: OnceLock<ModelSource>,
    vision: OnceLock<ModelSource>,
}

impl WorkerModel {
    /// Starts nothing: the child starts on the first load. `runtime` drives the download from
    /// the embedding thread.
    pub fn new(
        paths: &WorkerPaths,
        cache: PathBuf,
        runtime: Handle,
        exits: ExitObserver,
    ) -> Arc<Self> {
        let supervisor = Supervisor::new(
            paths.program.clone(),
            vec![
                "--pdfium-dir".into(),
                paths.pdfium_dir.clone().into(),
                "--model-cache".into(),
                cache.clone().into(),
            ],
            // The child drops the model 30 s after its last call (`IDLE_SHUTDOWN_MS`,
            // embeddings.ts:931-950), with the service's own idle unload.
            Limits {
                idle_exit: Duration::from_secs(30),
                ..Limits::default()
            },
            Arc::new(SystemClock),
        )
        .observing_exits(exits);
        Arc::new(Self(Arc::new(Shared {
            supervisor,
            cache,
            runtime,
            text: OnceLock::new(),
            audio: OnceLock::new(),
            vision: OnceLock::new(),
        })))
    }

    /// Kills the child, if one runs. The next load starts a new one.
    pub fn stop(&self) {
        self.0.supervisor.stop();
    }

    /// Every vault close stops the child with the embedding thread
    /// (`EmbeddingService::register`), as Electron's `stopEmbeddingModel` ends its utility process.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let model = self.clone();
        session.on_close("embedding-worker", Arc::new(move |_| model.stop()));
    }
}

impl Shared {
    /// The source of `group`'s files, kept in `cell`.
    fn source<'a>(
        &self,
        group: ModelGroup,
        cell: &'a OnceLock<ModelSource>,
    ) -> Result<&'a ModelSource, String> {
        if let Some(source) = cell.get() {
            return Ok(source);
        }
        let manifest = self
            .supervisor
            .model_manifest(group)
            .map_err(worker_error)?;
        let (dir, files) = checked(&self.cache, manifest.clone())?;
        let source = ModelSource::new(HUB_HOST, &manifest.repo, &manifest.revision, dir, files);
        Ok(cell.get_or_init(|| source))
    }

    /// Downloads an encoder group's missing files, with no progress event (the settings UI
    /// shows the text model's).
    fn prepare(
        &self,
        group: ModelGroup,
        cell: &OnceLock<ModelSource>,
        abort: &Abort,
    ) -> Result<(), String> {
        let source = self.source(group, cell)?;
        self.runtime
            .block_on(source.ensure(abort, &|_| {}))
            .map_err(|error| error.to_string())
    }
}

impl ModelLoader for WorkerModel {
    fn load(
        &self,
        abort: &Abort,
        progress: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<Box<dyn Engine>, String> {
        let shared = &self.0;
        let source = shared.source(ModelGroup::Text, &shared.text)?;
        shared
            .runtime
            .block_on(source.ensure(abort, progress))
            .map_err(|error| error.to_string())?;
        // A thread retired between the download and here (vault close, quit) starts no child.
        if abort.cancel.is_cancelled() {
            return Err("the model load was cancelled".to_owned());
        }
        shared.supervisor.embed_load().map_err(worker_error)?;
        Ok(Box::new(WorkerEngine {
            shared: shared.clone(),
            recording: None,
            opened: 0,
        }))
    }

    fn prepare_audio(&self, abort: &Abort) -> Result<(), String> {
        self.0.prepare(ModelGroup::Audio, &self.0.audio, abort)
    }

    fn prepare_vision(&self, abort: &Abort) -> Result<(), String> {
        self.0.prepare(ModelGroup::Vision, &self.0.vision, abort)
    }
}

struct WorkerEngine {
    shared: Arc<Shared>,
    /// The open recording and its handle, from `opened`.
    recording: Option<(u64, AudioRecording)>,
    opened: u64,
}

impl WorkerEngine {
    /// Frees the decoded samples (up to 230 MB) in the worker, best effort: after a crash or a
    /// timeout the child is gone and the lease answers at once.
    fn close_audio(&mut self) {
        if let Some((_, recording)) = self.recording.take()
            && let Err(error) = self.shared.supervisor.close_audio(recording)
        {
            tracing::debug!(scope = "Embeddings", "closing a recording failed: {error}");
        }
    }
}

impl Engine for WorkerEngine {
    fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, EmbedError> {
        self.shared.supervisor.embed_text(text).map_err(embed_error)
    }

    fn open_audio(&mut self, path: &Path) -> Result<AudioOpened, EmbedError> {
        self.close_audio();
        let recording = self
            .shared
            .supervisor
            .open_audio(path)
            .map_err(|error| match error {
                // The file's fault: unreadable, over the cap, or not a WAV the worker decodes.
                WorkerError::Failed(message) => EmbedError::Input(message),
                other => embed_error(other),
            })?;
        self.opened += 1;
        let opened = AudioOpened {
            recording: self.opened,
            windows: recording.windows(),
        };
        self.recording = Some((opened.recording, recording));
        if opened.windows == 0 {
            self.close_audio();
        }
        Ok(opened)
    }

    fn embed_audio_window(&mut self, recording: u64, window: u32) -> Result<Vec<f32>, EmbedError> {
        let Some((_, open)) = self.recording.as_ref().filter(|(id, _)| *id == recording) else {
            return Err(EmbedError::Input(
                "the recording is no longer open".to_owned(),
            ));
        };
        let last = window + 1 >= open.windows();
        let result = self.shared.supervisor.embed_audio_window(open, window);
        if last || result.is_err() {
            self.close_audio();
        }
        result.map_err(|error| match error {
            // The child that held it was replaced: neither the file's fault nor the encoder's.
            WorkerError::NotOpen => EmbedError::Input(error.to_string()),
            other => embed_error(other),
        })
    }

    /// An image the worker cannot decode is [`EmbedError::Input`] through `embed_error`; any
    /// other failure of the op is [`EmbedError::Failed`].
    fn embed_image(&mut self, image: &ImageInput) -> Result<Vec<f32>, EmbedError> {
        self.shared
            .supervisor
            .embed_image(&image.bytes, image.text.as_deref(), image.soft_tokens)
            .map_err(embed_error)
    }
}

fn embed_error(error: WorkerError) -> EmbedError {
    match error {
        // The child that held the model is gone or unusable: Electron's `failProcess`.
        WorkerError::Start(_)
        | WorkerError::Timeout { .. }
        | WorkerError::Exited(_)
        | WorkerError::Protocol(_)
        | WorkerError::Paused => EmbedError::Crashed(error.to_string()),
        // The file's fault, not the model's: nothing counts.
        WorkerError::Rejected(message) => EmbedError::Input(message),
        WorkerError::Stopped | WorkerError::NotOpen | WorkerError::Failed(_) => {
            EmbedError::Failed(error.to_string())
        }
    }
}

fn worker_error(error: WorkerError) -> String {
    error.to_string()
}

/// The model directory under `cache` and the files to download, from a manifest the worker sent.
/// The worker reads untrusted files in other ops, so nothing it names may leave `cache` or the
/// app's pinned repo and revision: every path is a plain `/`-separated name that no other entry
/// matches without regard to case (macOS and Windows fold it) and that no part of is a Windows
/// device name, and the pins are well formed.
pub fn checked(cache: &Path, manifest: Manifest) -> Result<(PathBuf, Vec<PinnedFile>), String> {
    let refused = |what: &str| {
        Err(format!(
            "the worker sent a malformed model manifest ({what})"
        ))
    };
    if manifest.repo != MODEL_REPO || manifest.revision != MODEL_REVISION {
        return refused("repo");
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_FILES {
        return refused("file count");
    }
    let mut files = Vec::with_capacity(manifest.files.len());
    let mut seen = HashSet::new();
    for file in manifest.files {
        if !plain_path(&file.path)
            || !seen.insert(file.path.to_ascii_lowercase())
            || file.size > MAX_FILE_SIZE
            || file.sha256.len() != 64
            || !is_lower_hex(&file.sha256)
        {
            return refused("file");
        }
        files.push(PinnedFile {
            path: file.path,
            size: file.size,
            sha256: file.sha256,
        });
    }
    let mut dir = cache.to_path_buf();
    dir.extend(MODEL_REPO.split('/'));
    Ok((dir, files))
}

/// `/`-separated names of letters, digits, `.`, `_` and `-`, none of them empty, ending in `.`
/// (Windows drops a trailing dot, so `..` and `a.` are refused too) or a Windows device name.
fn plain_path(path: &str) -> bool {
    path.len() <= 256
        && path.split('/').all(|part| {
            !part.is_empty()
                && !part.ends_with('.')
                && !windows_device(part)
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
}

/// `CON`, `aux.json`, `com1.txt`: Windows opens the device whatever the extension or case.
fn windows_device(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn is_lower_hex(text: &str) -> bool {
    text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Electron's `trackWorkerExit` (`embeddings.ts:748-755`): never throttled, since the crash
/// cadence is the signal. `telemetry` is read at each exit, so a service set up later is used.
pub fn exit_telemetry(
    telemetry: impl Fn() -> Option<Arc<Service>> + Send + Sync + 'static,
) -> ExitObserver {
    Arc::new(move |phase, code| {
        tracing::error!(
            scope = "Embeddings",
            phase = phase.as_str(),
            code,
            "the embedding worker exited"
        );
        if let Some(service) = telemetry() {
            service.track_main_log(
                Level::Error,
                "Embeddings",
                &format!("worker_exit_{}", phase.as_str()),
                Some("EmbeddingWorkerExit"),
                None,
                Some(Metrics {
                    value: code.map(f64::from),
                    ..Metrics::default()
                }),
            );
        }
    })
}

#[cfg(test)]
mod tests {
    use memry_ml_worker::ManifestFile;

    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            repo: "onnx-community/embeddinggemma-2-ONNX".into(),
            revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0".into(),
            files: vec![ManifestFile {
                path: "onnx/model_q4.onnx".into(),
                size: 490_742,
                sha256: "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9".into(),
            }],
        }
    }

    #[test]
    fn a_manifest_names_the_transformers_js_cache_layout() {
        let cache = Path::new("app").join("models").join("transformers");
        let (dir, files) = checked(&cache, manifest()).expect("valid");
        assert_eq!(
            dir,
            cache.join("onnx-community").join("embeddinggemma-2-ONNX")
        );
        assert_eq!(files[0].path, "onnx/model_q4.onnx");
    }

    /// Nothing the worker names may lead the download out of the model directory.
    type Edit = Box<dyn Fn(&mut Manifest)>;

    #[test]
    fn a_manifest_that_leaves_the_cache_or_is_malformed_is_refused() {
        let cache = Path::new("cache");
        let cases: Vec<Edit> = vec![
            Box::new(|m| m.repo = "../escape".into()),
            Box::new(|m| m.repo = "onnx-community/other".into()),
            Box::new(|m| m.revision = "main".into()),
            Box::new(|m| m.revision = "0".repeat(40)),
            Box::new(|m| m.files[0].path = "../../etc/passwd".into()),
            Box::new(|m| m.files[0].path = "onnx/./x".into()),
            Box::new(|m| m.files[0].path = "/abs".into()),
            Box::new(|m| m.files[0].path = "C:/x".into()),
            Box::new(|m| m.files[0].sha256 = "F9".repeat(32)),
            Box::new(|m| m.files[0].size = MAX_FILE_SIZE + 1),
            Box::new(|m| m.files.clear()),
            Box::new(|m| m.files = vec![m.files[0].clone(); MAX_FILES + 1]),
            Box::new(|m| m.files = vec![m.files[0].clone(); 2]),
            Box::new(|m| {
                let mut other = m.files[0].clone();
                other.path = "ONNX/Model_q4.onnx".into();
                m.files.push(other);
            }),
            Box::new(|m| m.files[0].path = "CON".into()),
            Box::new(|m| m.files[0].path = "onnx/aux.json".into()),
            Box::new(|m| m.files[0].path = "lpt9.bin".into()),
            Box::new(|m| m.files[0].path = "onnx/model.".into()),
        ];
        for (index, case) in cases.iter().enumerate() {
            let mut bad = manifest();
            case(&mut bad);
            assert!(checked(cache, bad).is_err(), "case {index}");
        }
    }
}

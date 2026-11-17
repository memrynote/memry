//! VoiceRecordingReadiness, the OpenAI key's keychain entry, and the model download against a local HTTP fake
//! of the hub (never the real CDN), in a real temp dir.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::errors::SecureStoreError;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::engine::{LocalEngine, limits};
use super::key::{OpenAiKey, SERVICE};
use super::model::{FILE, REPO, REVISION, VoiceModel, model_dir};
use super::*;
use crate::embedding::download::DownloadError;
use crate::embedding::service::{ModelProgress, Phase};
use crate::seams::secure_store::GenericSecrets;
use crate::services::file_text::WorkerPaths;

fn no_key() -> Result<bool, ()> {
    panic!("the local provider never reads the keychain")
}

#[test]
fn local_provider_is_ready_only_with_the_model() {
    let ready = readiness(VoiceProvider::Local, true, no_key).unwrap();
    assert_eq!(
        serde_json::to_value(&ready).unwrap(),
        json!({ "ready": true, "provider": "local" })
    );
    let missing = readiness(VoiceProvider::Local, false, no_key).unwrap();
    assert_eq!(
        serde_json::to_value(&missing).unwrap(),
        json!({
            "ready": false,
            "provider": "local",
            "reason": "missing-model",
            "message": "Download Whisper Small in Settings to record voice memos."
        })
    );
}

#[test]
fn openai_provider_is_ready_only_with_a_key() {
    let ready = readiness(VoiceProvider::OpenAi, false, || Ok::<_, ()>(true)).unwrap();
    assert_eq!(
        serde_json::to_value(&ready).unwrap(),
        json!({ "ready": true, "provider": "openai" })
    );
    let missing = readiness(VoiceProvider::OpenAi, true, || Ok::<_, ()>(false)).unwrap();
    assert_eq!(
        serde_json::to_value(&missing).unwrap(),
        json!({
            "ready": false,
            "provider": "openai",
            "reason": "missing-api-key",
            "message": "Add your OpenAI API key in Settings to record voice memos."
        })
    );
    assert_eq!(
        readiness(VoiceProvider::OpenAi, true, || Err("locked")),
        Err("locked")
    );
}

#[test]
fn the_provider_comes_from_the_stored_group() {
    let group = |value: serde_json::Value| value.as_object().unwrap().clone();
    assert_eq!(
        VoiceProvider::of_group(&group(json!({ "provider": "openai" }))),
        VoiceProvider::OpenAi
    );
    assert_eq!(
        VoiceProvider::of_group(&group(json!({ "provider": "local" }))),
        VoiceProvider::Local
    );
    assert_eq!(
        VoiceProvider::of_group(&group(json!({}))),
        VoiceProvider::Local
    );
    assert_eq!(
        VoiceProvider::of_group(&group(json!({ "provider": 7 }))),
        VoiceProvider::Local
    );
}

#[derive(Default)]
struct Keychain(Mutex<HashMap<(String, String), Vec<u8>>>);

impl GenericSecrets for Keychain {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        let entries = self.0.lock().unwrap();
        Ok(entries
            .get(&(service.to_owned(), account.to_owned()))
            .cloned())
    }

    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        let mut entries = self.0.lock().unwrap();
        entries.insert((service.to_owned(), account.to_owned()), value.to_vec());
        Ok(())
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        let mut entries = self.0.lock().unwrap();
        entries.remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}

impl Keychain {
    fn raw(&self, account: &str) -> Option<Vec<u8>> {
        self.get_secret(SERVICE, account).unwrap()
    }
}

#[test]
fn the_key_is_stored_trimmed_under_the_app_service_and_the_device_account() {
    let keychain = Arc::new(Keychain::default());
    let key = OpenAiKey::new(keychain.clone(), Some("work"));
    assert_eq!(SERVICE, "com.memrynote.memry.voice-transcription");
    assert!(!key.has_key().unwrap());

    key.set("  sk-test \n").unwrap();
    assert_eq!(keychain.raw("openai-work"), Some(b"sk-test".to_vec()));
    assert_eq!(keychain.raw("openai"), None);
    assert!(key.has_key().unwrap());
    // A fresh reader goes to the keychain, not the writer's cache.
    assert!(
        OpenAiKey::new(keychain.clone(), Some("work"))
            .has_key()
            .unwrap()
    );
    assert!(!OpenAiKey::new(keychain.clone(), None).has_key().unwrap());

    key.set("   ").unwrap();
    assert_eq!(keychain.raw("openai-work"), None);
    assert!(!key.has_key().unwrap());
}

#[test]
fn a_blank_stored_key_is_no_key() {
    let keychain = Arc::new(Keychain::default());
    keychain.set_secret(SERVICE, "openai", b"  ").unwrap();
    assert!(!OpenAiKey::new(keychain, None).has_key().unwrap());
}

/// One answer of the fake hub, taken in order per request; [`Answer::Whole`] once they run out.
#[derive(Clone, Copy)]
enum Answer {
    /// The file from the asked byte: a 206 with its `Content-Range` for a `Range` request.
    Whole,
    /// A 200 that holds only the first bytes of the file, a body cut short.
    Short(usize),
    /// The headers of the whole file, then nothing, never closing.
    Stall,
}

/// A local fake of the hub that serves `body` at the pinned file's path and 404 elsewhere.
struct Hub {
    url: String,
    /// The `Range` header of every request for the file.
    ranges: Mutex<Vec<Option<String>>>,
}

impl Hub {
    async fn start(body: Vec<u8>, script: Vec<Answer>) -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hub = Arc::new(Self {
            url: format!("http://{}", listener.local_addr().unwrap()),
            ranges: Mutex::default(),
        });
        let (server, body) = (hub.clone(), Arc::new(body));
        let script = Arc::new(Mutex::new(std::collections::VecDeque::from(script)));
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (server, body, script) = (server.clone(), body.clone(), script.clone());
                tokio::spawn(async move { server.answer(stream, &body, &script).await });
            }
        });
        hub
    }

    fn ranges(&self) -> Vec<Option<String>> {
        self.ranges.lock().unwrap().clone()
    }

    async fn answer(
        &self,
        mut stream: tokio::net::TcpStream,
        body: &[u8],
        script: &Mutex<std::collections::VecDeque<Answer>>,
    ) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                return;
            }
            head.push(byte[0]);
        }
        let head = String::from_utf8(head).unwrap().to_ascii_lowercase();
        if !head
            .starts_with(&format!("get /{REPO}/resolve/{REVISION}/{FILE} ").to_ascii_lowercase())
        {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await;
            return;
        }
        let range = head
            .lines()
            .find_map(|line| line.strip_prefix("range: ").map(str::to_owned));
        self.ranges.lock().unwrap().push(range.clone());
        let next = script.lock().unwrap().pop_front().unwrap_or(Answer::Whole);
        let from = range
            .as_deref()
            .and_then(|r| r.strip_prefix("bytes="))
            .map_or(0, |r| r.trim_end_matches('-').parse::<usize>().unwrap());
        let (status, sent, extra) = match next {
            Answer::Short(n) => ("200 OK", &body[..n], String::new()),
            Answer::Whole | Answer::Stall if from > 0 => (
                "206 Partial Content",
                &body[from..],
                format!(
                    "content-range: bytes {from}-{}/{}\r\n",
                    body.len() - 1,
                    body.len()
                ),
            ),
            Answer::Whole | Answer::Stall => ("200 OK", body, String::new()),
        };
        let header = format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\n{extra}connection: close\r\n\r\n",
            sent.len()
        );
        let _ = stream.write_all(header.as_bytes()).await;
        if let Answer::Stall = next {
            let _ = stream.flush().await;
            std::future::pending::<()>().await;
        }
        let _ = stream.write_all(sent).await;
    }

    /// Waits until the hub has seen `count` requests for the file.
    async fn requested(&self, count: usize) {
        tokio::time::timeout(HANG, async {
            while self.ranges.lock().unwrap().len() < count {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the download never asked the hub");
    }
}

/// A hang guard, never a bound on how fast the code is.
const HANG: Duration = Duration::from_secs(60);

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn recorder() -> (
    Arc<Mutex<Vec<ModelProgress>>>,
    impl Fn(ModelProgress) + Sync,
) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    (seen, move |event| sink.lock().unwrap().push(event))
}

const BODY: &[u8] = b"ggml test model bytes, not a real model";

/// An engine that never starts a child: the download tests read only its idle state.
fn idle_engine() -> Arc<LocalEngine> {
    let paths = WorkerPaths::new(
        std::path::Path::new("/nonexistent"),
        std::path::Path::new("/"),
    );
    LocalEngine::new(&paths, "/nonexistent/ggml-small.bin".into(), limits())
}

fn model(url: &str, dir: &std::path::Path, sha: &str) -> VoiceModel {
    let _ = rustls::crypto::ring::default_provider().install_default();
    VoiceModel::from_host(url, model_dir(dir), BODY.len() as u64, sha)
}

#[tokio::test]
async fn the_download_verifies_the_file_then_writes_the_marker() {
    let dir = tempfile::tempdir().unwrap();
    let url = Hub::start(BODY.to_vec(), Vec::new()).await.url.clone();
    let model = model(&url, dir.path(), &sha256(BODY));
    assert!(!model.status(&idle_engine()).downloaded);

    let (seen, sink) = recorder();
    model.download(&sink).await.unwrap();

    assert_eq!(std::fs::read(model.model_path()).unwrap(), BODY);
    let marker: serde_json::Value = serde_json::from_slice(
        &std::fs::read(model_dir(dir.path()).join("ggml-small.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(marker["model"], "ggml-small");
    assert_eq!(marker["sha256"], sha256(BODY));
    assert!(marker["downloadedAt"].as_str().unwrap().ends_with('Z'));
    let status = model.status(&idle_engine());
    assert!(status.downloaded && !status.loading && !status.loaded);
    assert_eq!(status.error, None);
    assert_eq!(status.name, "Whisper Small");

    let seen = seen.lock().unwrap();
    assert!(
        seen.iter()
            .any(|e| e.phase == Phase::Downloading && e.status == "Downloading Whisper Small...")
    );
    assert_eq!(
        seen.last(),
        Some(&ModelProgress::new(
            Phase::Ready,
            100,
            "Whisper Small ready"
        ))
    );
}

#[tokio::test]
async fn a_corrupted_download_is_rejected_and_removed() {
    let dir = tempfile::tempdir().unwrap();
    let mut flipped = BODY.to_vec();
    flipped[3] ^= 0x01;
    let url = Hub::start(flipped, Vec::new()).await.url.clone();
    let model = model(&url, dir.path(), &sha256(BODY));

    let (seen, sink) = recorder();
    let error = model.download(&sink).await.unwrap_err();

    assert!(
        matches!(error, DownloadError::HashMismatch { .. }),
        "{error}"
    );
    let folder = model_dir(dir.path());
    let left: Vec<_> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "files left behind: {left:?}");
    let status = model.status(&idle_engine());
    assert!(!status.downloaded && !status.loading);
    assert_eq!(status.error, Some(error.to_string()));
    assert_eq!(seen.lock().unwrap().last().unwrap().phase, Phase::Error);
}

#[test]
fn electrons_marker_alone_is_not_a_download() {
    let dir = tempfile::tempdir().unwrap();
    let folder = model_dir(dir.path());
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("whisper-small.json"),
        r#"{"model":"Xenova/whisper-small","downloadedAt":"2026-01-01T00:00:00.000Z"}"#,
    )
    .unwrap();
    let model = model("http://127.0.0.1:9", dir.path(), &sha256(BODY));
    assert!(!model.status(&idle_engine()).downloaded);

    // Our marker over a missing or cut file does not count either.
    std::fs::write(folder.join("ggml-small.json"), "{}").unwrap();
    assert!(!model.downloaded());
    std::fs::write(folder.join(FILE), &BODY[..4]).unwrap();
    assert!(!model.downloaded());
    std::fs::write(folder.join(FILE), BODY).unwrap();
    assert!(model.downloaded());
    assert!(folder.join("whisper-small.json").is_file());
}

#[tokio::test]
async fn a_cut_download_is_not_downloaded_and_the_next_one_resumes_with_a_range() {
    let dir = tempfile::tempdir().unwrap();
    let hub = Hub::start(BODY.to_vec(), vec![Answer::Short(10)]).await;
    let model = model(&hub.url, dir.path(), &sha256(BODY));
    let folder = model_dir(dir.path());

    let (_, sink) = recorder();
    let error = model.download(&sink).await.unwrap_err();
    assert!(matches!(error, DownloadError::Incomplete { .. }), "{error}");
    let status = model.status(&idle_engine());
    assert!(!status.downloaded && !status.loading);
    assert_eq!(status.error, Some(error.to_string()));
    assert!(!folder.join("ggml-small.json").exists());
    assert_eq!(
        std::fs::read(folder.join(format!("{FILE}.part"))).unwrap(),
        &BODY[..10]
    );

    model.download(&sink).await.unwrap();
    assert_eq!(hub.ranges(), [None, Some("bytes=10-".to_owned())]);
    assert_eq!(std::fs::read(model.model_path()).unwrap(), BODY);
    let status = model.status(&idle_engine());
    assert!(status.downloaded && !status.loading);
    assert_eq!(status.error, None);
    assert!(folder.join("ggml-small.json").is_file());
}

#[tokio::test]
async fn stop_cancels_the_download_and_keeps_the_reason() {
    let dir = tempfile::tempdir().unwrap();
    let hub = Hub::start(BODY.to_vec(), vec![Answer::Stall]).await;
    let model = model(&hub.url, dir.path(), &sha256(BODY));

    let (seen, sink) = recorder();
    let (outcome, ()) = tokio::join!(model.download(&sink), async {
        hub.requested(1).await;
        model.stop();
    });

    let error = outcome.unwrap_err();
    assert!(matches!(error, DownloadError::Cancelled), "{error}");
    let status = model.status(&idle_engine());
    assert!(!status.downloaded && !status.loading);
    assert_eq!(status.error, Some(DownloadError::Cancelled.to_string()));
    assert!(!model_dir(dir.path()).join("ggml-small.json").exists());
    assert_eq!(seen.lock().unwrap().last().unwrap().phase, Phase::Error);
}

#[tokio::test]
async fn the_model_is_loading_while_any_download_is_in_flight() {
    let dir = tempfile::tempdir().unwrap();
    let hub = Hub::start(BODY.to_vec(), vec![Answer::Short(10), Answer::Stall]).await;
    let model = model(&hub.url, dir.path(), &sha256(BODY));
    let (_, sink) = recorder();

    // The second download waits for the first, then stalls on the hub.
    let first_ends = async {
        let first = model.download(&sink).await;
        assert!(
            matches!(first, Err(DownloadError::Incomplete { .. })),
            "{first:?}"
        );
        hub.requested(2).await;
        model.status(&idle_engine()).loading
    };
    tokio::select! {
        biased;
        loading = first_ends => assert!(loading, "the second download is still in flight"),
        second = model.download(&sink) => panic!("the stalled download ended: {second:?}"),
    }
    // A download dropped in flight leaves no loading behind.
    assert!(!model.status(&idle_engine()).loading);
}

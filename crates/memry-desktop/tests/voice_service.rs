//! Voice transcription end to end (`services::voice::service::VoiceService`), as Electron's
//! `transcription.ts`: the OpenAI engine against a loopback fake of the API (never the real one),
//! the local engine over the stub worker (`memry-ml-worker/src/bin/stub.rs`, whose answer is its
//! pid), and the outcome written onto a voice memo of a real core vault in a temp dir.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, StatusCode};
use chrono::FixedOffset;
use memry_core::api::errors::SecureStoreError;
use memry_core::api::inbox::Inbox;
use memry_core::api::vault::Vault;
use memry_core::domain::inbox::enrich::VoiceMemoName;
use memry_core::storage::repositories::sync_items;
use memry_desktop::seams::secure_store::GenericSecrets;
use memry_desktop::services::file_text::WorkerPaths;
use memry_desktop::services::voice::engine::{LocalEngine, limits};
use memry_desktop::services::voice::key::{OpenAiKey, SERVICE};
use memry_desktop::services::voice::naming::memo_name;
use memry_desktop::services::voice::openai::{self, OpenAi};
use memry_desktop::services::voice::service::{Progress, TranscriptionResult, VoiceService};
use memry_desktop::services::voice::{MemoNameMode, VoiceProvider, VoiceSettings};
use serde_json::{Value, json};

use crate::device_key::with_device_key;

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
        self.0
            .lock()
            .unwrap()
            .remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}

/// One request the fake API received.
struct Seen {
    headers: HeaderMap,
    body: Vec<u8>,
}

/// A loopback fake of `POST /v1/audio/transcriptions` answering from `script`, in order.
async fn openai_host(script: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let script = Arc::new(Mutex::new(VecDeque::from(script)));
    let record = seen.clone();
    let app = axum::Router::new().route(
        "/v1/audio/transcriptions",
        axum::routing::post(move |headers: HeaderMap, body: axum::body::Bytes| {
            let (record, script) = (record.clone(), script.clone());
            async move {
                record.lock().unwrap().push(Seen {
                    headers,
                    body: body.to_vec(),
                });
                let (status, body) = script.lock().unwrap().pop_front().expect("an answer");
                (StatusCode::from_u16(status).unwrap(), body)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    (
        format!("http://127.0.0.1:{port}/v1/audio/transcriptions"),
        seen,
    )
}

fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// A service whose OpenAI engine talks to `endpoint` with `key` stored, and whose local engine is
/// the stub worker with a model under `dir`.
fn service(
    dir: &Path,
    endpoint: &str,
    key: Option<&str>,
    model: Option<&str>,
) -> Arc<VoiceService> {
    notifying(dir, endpoint, key, model, Arc::default())
}

/// [`service`], recording each memo it announces to the embedding lane in `notified`.
fn notifying(
    dir: &Path,
    endpoint: &str,
    key: Option<&str>,
    model: Option<&str>,
    notified: Arc<Mutex<Vec<String>>>,
) -> Arc<VoiceService> {
    let keychain = Arc::new(Keychain::default());
    if let Some(key) = key {
        keychain
            .set_secret(SERVICE, "openai", key.as_bytes())
            .unwrap();
    }
    let paths = WorkerPaths {
        program: PathBuf::from(env!("CARGO_BIN_EXE_memry-desktop-worker-stub")),
        pdfium_dir: dir.join("pdfium"),
    };
    let mut limits = limits();
    // A hang guard: a fresh link under load can take over the app's 10 s to start.
    limits.start_timeout = std::time::Duration::from_secs(60);
    VoiceService::new(
        LocalEngine::new(&paths, dir.join("ggml-small.bin"), limits),
        OpenAiKey::new(keychain, None),
        OpenAi::new(client(), endpoint, model),
        Arc::new(move |item_id| notified.lock().unwrap().push(item_id.to_owned())),
    )
}

fn settings(provider: VoiceProvider, mode: MemoNameMode, language: Option<&str>) -> VoiceSettings {
    VoiceSettings {
        provider,
        memo_name_mode: mode,
        language: language.map(str::to_owned),
        audio_search: true,
    }
}

fn no_progress() -> Progress {
    Arc::new(|_| {})
}

/// A field of a multipart body: the text between its headers and the next boundary.
fn field(body: &[u8], name: &str) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let start = text.find(&format!("name=\"{name}\""))?;
    let value = &text[start..];
    let value = &value[value.find("\r\n\r\n")? + 4..];
    Some(value[..value.find("\r\n--")?].to_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn openai_gets_the_file_model_and_text_format_and_language_only_when_set() {
    let dir = tempfile::tempdir().unwrap();
    let (endpoint, seen) = openai_host(vec![(200, "Call the bank.\n"), (200, "Hola.\n")]).await;
    let voice = service(dir.path(), &endpoint, Some("sk-test"), None);
    let openai = settings(VoiceProvider::OpenAi, MemoNameMode::Transcript, None);

    let text = voice
        .transcribe(&openai, b"RIFFaudio".to_vec(), "wav", no_progress())
        .await;
    assert_eq!(text.as_deref(), Ok("Call the bank.\n"));
    let spanish = settings(VoiceProvider::OpenAi, MemoNameMode::Transcript, Some("es"));
    let text = voice
        .transcribe(&spanish, b"webm".to_vec(), "webm", no_progress())
        .await;
    assert_eq!(text.as_deref(), Ok("Hola.\n"));

    let seen = seen.lock().unwrap();
    let first = &seen[0];
    assert_eq!(first.headers["authorization"], "Bearer sk-test");
    assert!(
        first.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary=")
    );
    assert_eq!(field(&first.body, "model").as_deref(), Some("whisper-1"));
    assert_eq!(
        field(&first.body, "response_format").as_deref(),
        Some("text")
    );
    assert_eq!(field(&first.body, "language"), None);
    let file = String::from_utf8_lossy(&first.body);
    assert!(file.contains("filename=\"audio.wav\"\r\nContent-Type: audio/wav"));
    assert_eq!(field(&first.body, "file").as_deref(), Some("RIFFaudio"));
    assert_eq!(field(&seen[1].body, "language").as_deref(), Some("es"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_model_variable_picks_the_openai_model() {
    let dir = tempfile::tempdir().unwrap();
    let (endpoint, seen) = openai_host(vec![(200, "ok")]).await;
    let voice = service(
        dir.path(),
        &endpoint,
        Some("sk-test"),
        Some("gpt-4o-transcribe"),
    );
    let openai = settings(VoiceProvider::OpenAi, MemoNameMode::Transcript, None);
    voice
        .transcribe(&openai, b"a".to_vec(), "mp3", no_progress())
        .await
        .unwrap();
    let body = &seen.lock().unwrap()[0].body;
    assert_eq!(field(body, "model").as_deref(), Some("gpt-4o-transcribe"));
}

/// `normalizeTranscriptionError`: an exhausted quota (a 429 too), a rate limit, a bad key, and
/// the API's own message for the rest.
#[tokio::test(flavor = "multi_thread")]
async fn openai_failures_read_as_electrons_messages() {
    let dir = tempfile::tempdir().unwrap();
    let (endpoint, _) = openai_host(vec![
        (
            429,
            r#"{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}"#,
        ),
        (
            429,
            r#"{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}"#,
        ),
        (
            401,
            r#"{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}"#,
        ),
        (400, r#"{"error":{"message":"Invalid file format.","code":null}}"#),
    ])
    .await;
    let voice = service(dir.path(), &endpoint, Some("sk-test"), None);
    let openai = settings(VoiceProvider::OpenAi, MemoNameMode::Transcript, None);
    let mut errors = Vec::new();
    for _ in 0..4 {
        let outcome = voice
            .transcribe(&openai, b"a".to_vec(), "wav", no_progress())
            .await;
        errors.push(outcome.unwrap_err());
    }
    assert_eq!(
        errors,
        [
            openai::NO_QUOTA,
            openai::RATE_LIMITED,
            openai::INVALID_KEY,
            "400 Invalid file format."
        ]
    );
}

/// Over 25 MB, a format OpenAI does not take, or no key: refused before any request.
#[tokio::test(flavor = "multi_thread")]
async fn openai_refusals_send_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (endpoint, seen) = openai_host(vec![]).await;
    let openai = settings(VoiceProvider::OpenAi, MemoNameMode::Transcript, None);
    let voice = service(dir.path(), &endpoint, Some("sk-test"), None);

    let large = vec![0u8; openai::MAX_BYTES + 1];
    let refused = voice.transcribe(&openai, large, "wav", no_progress()).await;
    assert_eq!(
        refused.unwrap_err(),
        "Audio file too large: 25MB. Maximum size is 25MB."
    );
    let refused = voice
        .transcribe(&openai, b"a".to_vec(), "flac", no_progress())
        .await;
    assert_eq!(
        refused.unwrap_err(),
        "Unsupported audio format: flac. Supported: mp3, mp4, mpeg, mpga, m4a, wav, webm"
    );
    let keyless = service(dir.path(), &endpoint, None, None);
    let refused = keyless
        .transcribe(&openai, b"a".to_vec(), "wav", no_progress())
        .await;
    assert_eq!(
        refused.unwrap_err(),
        "OpenAI API key not configured in Settings."
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_local_engine_takes_wav_only_and_defaults_to_english() {
    let dir = tempfile::tempdir().unwrap();
    let voice = service(dir.path(), "http://127.0.0.1:9/none", None, None);
    let local = settings(VoiceProvider::Local, MemoNameMode::Transcript, None);
    let refused = voice
        .transcribe(&local, b"webm".to_vec(), "webm", no_progress())
        .await;
    assert_eq!(
        refused.unwrap_err(),
        "Local transcription requires WAV voice memos. Record a new memo or switch to OpenAI."
    );
    // The stub answers its pid for any language but `xx`, which it rejects.
    let text = voice
        .transcribe(&local, b"RIFF".to_vec(), "wav", no_progress())
        .await
        .unwrap();
    assert!(text.parse::<u32>().is_ok(), "{text}");
    let rejected = settings(VoiceProvider::Local, MemoNameMode::Transcript, Some("xx"));
    let refused = voice
        .transcribe(&rejected, b"RIFF".to_vec(), "wav", no_progress())
        .await;
    assert!(
        refused
            .unwrap_err()
            .contains("unknown transcription language xx")
    );
    voice.engine().stop();
}

/// A vault with one voice memo whose file is `audio` at `voice-memo.<ext>`.
struct Memo {
    root: tempfile::TempDir,
    vault: Vault,
    inbox: Arc<Inbox>,
    id: String,
}

fn memo(audio: &[u8], ext: &str) -> Memo {
    let root = tempfile::tempdir().unwrap();
    let vault = Vault::open("vault".into(), root.path().to_string_lossy().into_owned()).unwrap();
    let inbox = vault.inbox(with_device_key()).unwrap();
    let id = inbox.new_id();
    let rel = format!("attachments/inbox/{id}/voice-memo.{ext}");
    let file = root.path().join(&rel);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, audio).unwrap();
    let size = audio.len() as u64;
    let item = inbox
        .capture_voice(
            id.clone(),
            7.0,
            ext.into(),
            size,
            rel,
            vec![],
            Some("pending".into()),
            None,
        )
        .unwrap();
    assert_eq!(item.title, "Voice memo (0:07)");
    Memo {
        root,
        vault,
        inbox,
        id,
    }
}

impl Memo {
    async fn transcribe(
        &self,
        voice: &Arc<VoiceService>,
        settings: VoiceSettings,
    ) -> TranscriptionResult {
        voice
            .on_voice_captured(
                self.inbox.clone(),
                self.root.path().to_path_buf(),
                settings,
                self.id.clone(),
                no_progress(),
            )
            .await
    }

    fn payload(&self) -> Value {
        let id = self.id.clone();
        let raw = self
            .vault
            .db_handle()
            .call_blocking(move |conn| Ok(sync_items::push_payload(conn, "inbox", &id)?.unwrap()))
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transcribed_memo_is_complete_and_named_after_its_first_sentence() {
    let dir = tempfile::tempdir().unwrap();
    let (endpoint, _) = openai_host(vec![(200, "Call the bank. Then lunch.")]).await;
    let voice = service(dir.path(), &endpoint, Some("sk-test"), None);
    let memo = memo(b"RIFFaudio", "wav");
    let openai = settings(VoiceProvider::OpenAi, MemoNameMode::Transcript, None);

    let result = memo.transcribe(&voice, openai).await;
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({ "success": true, "transcription": "Call the bank. Then lunch." })
    );
    let payload = memo.payload();
    assert_eq!(payload["title"], "Call the bank.");
    assert_eq!(payload["transcription"], "Call the bank. Then lunch.");
    assert_eq!(payload["transcriptionStatus"], "complete");
    assert_eq!(payload["processingError"], Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn memo_name_mode_none_keeps_the_default_title() {
    let dir = tempfile::tempdir().unwrap();
    let voice = service(dir.path(), "http://127.0.0.1:9/none", None, None);
    let memo = memo(b"RIFF", "wav");
    let local = settings(VoiceProvider::Local, MemoNameMode::None, None);

    let result = memo.transcribe(&voice, local).await;
    assert!(result.success, "{result:?}");
    let payload = memo.payload();
    assert_eq!(payload["title"], "Voice memo (0:07)");
    assert_eq!(payload["transcriptionStatus"], "complete");
    voice.engine().stop();
}

/// `titleFromTimestamp`: the creation time in local time, here a fixed zone.
#[test]
fn the_timestamp_name_is_the_creation_time_in_the_zone() {
    // 2026-11-17T06:05:00Z.
    let created = 1_794_895_500_000;
    let istanbul = FixedOffset::east_opt(3 * 3600).unwrap();
    assert_eq!(
        memo_name(MemoNameMode::Timestamp, created, &istanbul),
        VoiceMemoName::Title("Voice memo 2026-11-17 09:05".into())
    );
    assert_eq!(
        memo_name(MemoNameMode::Transcript, created, &istanbul),
        VoiceMemoName::Transcript
    );
    assert_eq!(
        memo_name(MemoNameMode::None, created, &istanbul),
        VoiceMemoName::Keep
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failure_is_stored_on_the_memo_and_a_retry_completes_it() {
    let dir = tempfile::tempdir().unwrap();
    let (endpoint, _) = openai_host(vec![
        (
            429,
            r#"{"error":{"message":"slow down","code":"rate_limit_exceeded"}}"#,
        ),
        (200, "Second try."),
    ])
    .await;
    let notified = Arc::<Mutex<Vec<String>>>::default();
    let voice = notifying(
        dir.path(),
        &endpoint,
        Some("sk-test"),
        None,
        notified.clone(),
    );
    let memo = memo(b"RIFFaudio", "wav");
    let mut openai = settings(VoiceProvider::OpenAi, MemoNameMode::Transcript, None);
    // The lane embeds a transcript whatever `audioSearch` says, so both outcomes announce.
    openai.audio_search = false;

    let failed = memo.transcribe(&voice, openai.clone()).await;
    assert_eq!(failed.error.as_deref(), Some(openai::RATE_LIMITED));
    let payload = memo.payload();
    assert_eq!(payload["transcriptionStatus"], "failed");
    assert_eq!(payload["processingError"], openai::RATE_LIMITED);
    assert_eq!(*notified.lock().unwrap(), [memo.id.clone()]);

    let retried = voice
        .retry_transcription(
            memo.inbox.clone(),
            memo.root.path().to_path_buf(),
            openai,
            memo.id.clone(),
            no_progress(),
        )
        .await;
    assert!(retried.success, "{retried:?}");
    let payload = memo.payload();
    assert_eq!(payload["transcriptionStatus"], "complete");
    assert_eq!(payload["processingError"], Value::Null);
    assert_eq!(payload["title"], "Second try.");
    assert_eq!(
        *notified.lock().unwrap(),
        [memo.id.clone(), memo.id.clone()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_retry_refuses_a_memo_that_is_not_voice_and_an_unknown_item() {
    let dir = tempfile::tempdir().unwrap();
    let voice = service(dir.path(), "http://127.0.0.1:9/none", None, None);
    let memo = memo(b"RIFF", "wav");
    let local = settings(VoiceProvider::Local, MemoNameMode::Transcript, None);
    let text = memo
        .inbox
        .capture_text("a thought".into(), None, None, false)
        .unwrap();
    let retry = |id: String| {
        voice.retry_transcription(
            memo.inbox.clone(),
            memo.root.path().to_path_buf(),
            local.clone(),
            id,
            no_progress(),
        )
    };
    assert_eq!(
        retry(text.item.id.clone()).await.error.as_deref(),
        Some("Item is not a voice memo")
    );
    assert_eq!(
        retry("missing".into()).await.error.as_deref(),
        Some("Item not found")
    );
}

/// The attachment path is synced data: one that leaves the vault never reaches an engine.
#[tokio::test(flavor = "multi_thread")]
async fn a_memo_whose_file_is_outside_the_vault_fails_without_reading_it() {
    let dir = tempfile::tempdir().unwrap();
    let (endpoint, seen) = openai_host(vec![]).await;
    let voice = service(dir.path(), &endpoint, Some("sk-test"), None);
    let memo = memo(b"RIFF", "wav");
    let outside = dir.path().join("secret.wav");
    std::fs::write(&outside, b"not yours").unwrap();
    let rel = format!(
        "../{}/secret.wav",
        dir.path().file_name().unwrap().to_string_lossy()
    );
    let id = memo.inbox.new_id();
    memo.inbox
        .capture_voice(
            id.clone(),
            1.0,
            "wav".into(),
            9,
            rel,
            vec![],
            Some("pending".into()),
            None,
        )
        .unwrap();
    let openai = settings(VoiceProvider::OpenAi, MemoNameMode::Transcript, None);

    let result = voice
        .on_voice_captured(
            memo.inbox.clone(),
            memo.root.path().to_path_buf(),
            openai,
            id.clone(),
            no_progress(),
        )
        .await;
    assert!(!result.success);
    assert!(seen.lock().unwrap().is_empty());
    let item = memo.inbox.get(id).unwrap().unwrap();
    assert_eq!(item.transcription_status.as_deref(), Some("failed"));
}

#[test]
fn the_settings_group_reads_with_electrons_defaults() {
    let group = |value: Value| VoiceSettings::of_group(value.as_object().unwrap());
    assert_eq!(
        group(json!({ "provider": "local", "memoNameMode": "transcript" })),
        settings(VoiceProvider::Local, MemoNameMode::Transcript, None)
    );
    let stored = group(json!({
        "provider": "openai",
        "memoNameMode": "timestamp",
        "language": "tr",
        "audioSearch": false
    }));
    assert_eq!(
        stored,
        VoiceSettings {
            audio_search: false,
            ..settings(VoiceProvider::OpenAi, MemoNameMode::Timestamp, Some("tr"))
        }
    );
    assert_eq!(
        group(json!({ "memoNameMode": "none" })).memo_name_mode,
        MemoNameMode::None
    );
}

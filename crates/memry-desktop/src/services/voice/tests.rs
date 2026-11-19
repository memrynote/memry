//! VoiceRecordingReadiness, the OpenAI key's keychain entry, and the model download against a local HTTP fake
//! of the hub (never the real CDN), in a real temp dir.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::key::{OpenAiKey, SERVICE};
use super::model::{FILE, REPO, REVISION, VoiceModel, model_dir};
use super::*;
use crate::embedding::download::DownloadError;
use crate::embedding::service::{ModelProgress, Phase};
use crate::seams::secure_store::GenericSecrets;

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

/// Serves `body` at the pinned file's path and 404 elsewhere, ignoring any range.
async fn hub(body: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let body = Arc::new(body);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let body = body.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8(head).unwrap();
                let wanted = format!("GET /{REPO}/resolve/{REVISION}/{FILE} ");
                let answer = if head.starts_with(&wanted) {
                    let mut answer = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes();
                    answer.extend_from_slice(&body);
                    answer
                } else {
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        .to_vec()
                };
                let _ = stream.write_all(&answer).await;
            });
        }
    });
    url
}

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

fn model(url: &str, dir: &std::path::Path, sha: &str) -> VoiceModel {
    let _ = rustls::crypto::ring::default_provider().install_default();
    VoiceModel::from_host(url, model_dir(dir), BODY.len() as u64, sha)
}

#[tokio::test]
async fn the_download_verifies_the_file_then_writes_the_marker() {
    let dir = tempfile::tempdir().unwrap();
    let url = hub(BODY.to_vec()).await;
    let model = model(&url, dir.path(), &sha256(BODY));
    assert!(!model.status().downloaded);

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
    let status = model.status();
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
    let url = hub(flipped).await;
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
    let status = model.status();
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
    assert!(!model.status().downloaded);

    // Our marker over a missing or cut file does not count either.
    std::fs::write(folder.join("ggml-small.json"), "{}").unwrap();
    assert!(!model.downloaded());
    std::fs::write(folder.join(FILE), &BODY[..4]).unwrap();
    assert!(!model.downloaded());
    std::fs::write(folder.join(FILE), BODY).unwrap();
    assert!(model.downloaded());
    assert!(folder.join("whisper-small.json").is_file());
}

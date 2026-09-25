//! The `Inbox` UniFFI surface end to end (spec 006 IB021, IB022, IB028):
//! file captures carry desktop's attachment path and metadata, and every
//! write lands in the outbox.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::FakeSecureStore;
use memry_core::api::inbox::Inbox;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::storage::repositories::sync_items;
use serde_json::Value;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open() -> (Vault, Arc<Inbox>) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf =
        std::env::temp_dir().join(format!("memry-api-inbox-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[4u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let inbox = vault.inbox(store).expect("the inbox surface");
    (vault, inbox)
}

fn payload(vault: &Vault, id: &str) -> Value {
    let id = id.to_owned();
    vault
        .db_handle()
        .call_blocking(move |conn| {
            Ok(sync_items::push_payload(conn, "inbox", &id)?.expect("payload"))
        })
        .map(|raw| serde_json::from_str(&raw).expect("json"))
        .expect("read")
}

#[test]
fn a_file_capture_carries_its_attachment_path_and_metadata() {
    let (vault, inbox) = open();
    let id = inbox.new_id();
    let path = format!("attachments/inbox/{id}/a1b2c3-receipt.jpg");
    assert!(inbox.check_file("image/heic".into(), 10).is_err());
    assert!(
        inbox
            .check_file("image/jpeg".into(), 51 * 1024 * 1024)
            .is_err()
    );
    let item = inbox
        .capture_file(
            id.clone(),
            "image/jpeg".into(),
            "receipt.jpg".into(),
            2_048,
            path.clone(),
            None,
            Some(r#"{"width":3024,"height":4032,"format":"jpeg"}"#.into()),
            Some("inline".into()),
        )
        .expect("capture");
    assert_eq!(
        (item.item_type.as_str(), item.title.as_str()),
        ("image", "receipt")
    );
    assert!(item.is_binary && item.is_note_only);
    let p = payload(&vault, &id);
    assert_eq!(p["attachmentPath"], path.as_str());
    assert_eq!(p["metadata"]["originalFilename"], "receipt.jpg");
    assert_eq!(p["metadata"]["width"], 3024);
    assert_eq!(p["metadata"]["fileSize"], 2048);
    let read = inbox.get(id).expect("get").expect("live");
    assert_eq!(read.attachment_path.as_deref(), Some(path.as_str()));
}

#[test]
fn a_voice_memo_is_titled_and_transcribed() {
    let (vault, inbox) = open();
    let id = inbox.new_id();
    let item = inbox
        .capture_voice(
            id.clone(),
            42.0,
            "m4a".into(),
            1_000,
            format!("attachments/inbox/{id}/voice-memo.m4a"),
            vec![0.1, 0.5],
            Some("pending".into()),
            Some("inline".into()),
        )
        .expect("capture");
    assert_eq!(item.title, "Voice memo (0:42)");
    assert_eq!(item.transcription_status.as_deref(), Some("pending"));
    let done = inbox
        .set_transcription(
            id.clone(),
            Some("[agent] Pick up the cable. Then more.".into()),
            "complete".into(),
        )
        .expect("transcribed");
    assert_eq!(done.title, "[agent] Pick up the cable.");
    assert_eq!(
        payload(&vault, &id)["transcription"],
        "[agent] Pick up the cable. Then more."
    );
    let renamed = inbox
        .rename(id.clone(), "[agent] Cable".into())
        .expect("rename");
    assert_eq!(renamed.title, "[agent] Cable");
    let stats = inbox.stats(i64::MAX / 4, 7).expect("stats");
    assert_eq!(stats.reviewable, 1);
}

#[test]
fn text_captures_file_and_convert_through_the_surface() {
    let (_vault, inbox) = open();
    let out = inbox
        .capture_text(
            "[agent] surface thought".into(),
            None,
            Some("inline".into()),
            false,
        )
        .expect("capture");
    assert!(!out.duplicate);
    let again = inbox
        .capture_text("[agent] surface thought".into(), None, None, false)
        .expect("duplicate check");
    assert!(again.duplicate);
    let filed = inbox
        .file_to_folder(
            out.item.id.clone(),
            Some("Agent Test".into()),
            vec!["x".into()],
            "2026-09-24T10:00".into(),
        )
        .expect("file");
    assert_eq!(filed.filed_to, "Agent Test/[agent] surface thought.md");
    assert!(inbox.list(false).expect("list").is_empty());
    assert_eq!(inbox.filing_history(5).expect("history").len(), 1);
    assert_eq!(inbox.recent_folders(5).expect("recent"), ["Agent Test"]);
}

//! A journal day with a picture is not a note on a pulled device (#5730).
//!
//! Desktop names a day's pictures in a `note` record under the day's own id
//! (`recordOnNote`, `apps/desktop/src/main/sync/note-attachment-metadata.ts`).
//! The core keeps that record's `notes` row for its attachment references
//! (`journal_embedded_attachments.rs` on the #5727 branch pins the pictures),
//! so every reader that lists or classifies notes has to read the row as the
//! day's, not as a note. Real first sync and pull, real chapter 04 crypto,
//! real SQLite; only the transport and the secure store are fakes.

mod http_fakes;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, error_response, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::crypto::derive_vault_key;
use memry_core::api::errors::TransportError;
use memry_core::api::search::BacklinkOrder;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::domain::journal_ops::links;
use memry_core::domain::note_meta;
use memry_core::domain::related_items;
use memry_core::protocol::account::{AccountSealer, DeviceSigner};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope::SyncOperation;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::SyncItemRow;
use memry_core::sync::push::{PendingRecord, PushSealer as _};
use rusqlite::Connection;
use serde_json::{Value as Json, json};

const BASE: &str = "https://sync.example.com";
const DAY: &str = "j2020-01-01";
const DATE: &str = "2020-01-01";
const NOTE: &str = "note-trip";
const DEVICE: &str = "device-a";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
const OLD: &str = "2020-01-01T00:00:00.000Z";

type Scripted = Result<HttpResponse, TransportError>;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_vault() -> Vault {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-journal-day-reads-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open")
}

fn session(transport: Arc<FakeTransport>) -> Arc<AuthSession> {
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &http_fakes::jwt(json!({"sub": "user-1", "device_id": DEVICE, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    Arc::new(
        AuthSession::new(
            transport,
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "phone".to_string(),
                platform: DevicePlatform::Ios,
                form_factor: None,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    )
}

fn devices() -> Scripted {
    let (public, _) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    response(
        200,
        &json!({"devices": [{"id": DEVICE, "signingPublicKey": BASE64.encode(&public)}]})
            .to_string(),
    )
}

fn sealed(item_type: &str, item_id: &str, payload: Json) -> Json {
    let (_, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let sealer = AccountSealer::new(
        derive_vault_key(MASTER_KEY.to_vec()).expect("vault key"),
        DeviceSigner::new(DEVICE, secret.to_vec()).expect("a signer"),
    );
    sealer
        .seal_record(&PendingRecord {
            operation: SyncOperation::Update,
            row: SyncItemRow {
                item_type: item_type.to_owned(),
                item_id: item_id.to_owned(),
                payload: Some(payload.to_string()),
                payload_state: "full".to_owned(),
                clock: Some(json!({ DEVICE: 1 }).to_string()),
                field_clocks: None,
                server_cursor: None,
                signer_device_id: None,
                updated_at: 1,
                deleted_at: None,
                corrupt_reason: None,
                corrupt_at: None,
            },
        })
        .expect("seals")
}

/// What desktop pushes for a tagged journal day with one picture: the
/// `journal` record and the same-id `note` record `recordOnNote` pushes,
/// built from the shared `note_metadata` row (its tags included).
fn desktop_records() -> Vec<(&'static str, &'static str, Json)> {
    vec![
        (
            "journal",
            DAY,
            json!({
                "date": DATE, "content": null, "tags": ["trip"], "properties": null,
                "clock": { DEVICE: 1 }, "createdAt": OLD, "modifiedAt": OLD,
            }),
        ),
        (
            "note",
            DAY,
            json!({
                "title": DATE, "fileType": "markdown", "tags": ["trip"],
                "attachmentReferences": ["c2aaafaa721c3893a1fb8ca144718a1e"],
                "folderPath": "journal",
                "clock": { DEVICE: 1 }, "createdAt": OLD, "modifiedAt": OLD,
            }),
        ),
        (
            "note",
            NOTE,
            json!({
                "title": "Trip plan", "fileType": "markdown", "tags": ["trip"],
                "folderPath": "",
                "clock": { DEVICE: 1 }, "createdAt": OLD, "modifiedAt": OLD,
            }),
        ),
    ]
}

/// A fresh device's first sync of `records`: the bootstrap 501, no record
/// packs, the changes page, the records, and no body packs.
async fn pulled_vault() -> Vault {
    let records = desktop_records();
    let items: Vec<Json> = records
        .iter()
        .map(|(kind, id, _)| {
            json!({
                "id": id, "type": kind, "version": 1,
                "modifiedAt": instants::to_epoch_ms(OLD).expect("an instant"),
                "size": 12,
            })
        })
        .collect();
    let sealed: Vec<Json> = records
        .into_iter()
        .map(|(kind, id, payload)| sealed(kind, id, payload))
        .collect();
    let transport = FakeTransport::new(vec![
        devices(),
        error_response(501, "BOOTSTRAP_UNAVAILABLE", "no bootstrap key"),
        error_response(404, "NOT_FOUND", "no pack route"),
        response(
            200,
            &json!({ "items": items, "deleted": [], "hasMore": false, "nextCursor": 10 })
                .to_string(),
        ),
        response(200, &json!({ "items": sealed }).to_string()),
        error_response(404, "NOT_FOUND", "no pack route"),
    ]);
    let vault = scratch_vault();
    vault
        .sync(session(transport))
        .first_sync(None)
        .await
        .expect("the first sync");
    vault
}

#[tokio::test]
async fn the_notes_list_tags_and_wiki_links_do_not_read_the_day_as_a_note() {
    let vault = pulled_vault().await;
    let ids = |rows: Vec<memry_core::domain::reads::NoteSummary>| {
        rows.into_iter().map(|row| row.id).collect::<Vec<_>>()
    };
    // The row stays: it carries the day's attachment references.
    let held = vault
        .db_handle()
        .call_blocking(|conn| Ok(memry_core::domain::reads::note_exists(conn, DAY)))
        .expect("read");
    assert!(held, "the day's note row is kept for its pictures");

    let notes = vault.notes();
    assert_eq!(ids(notes.list().expect("list")), [NOTE]);
    assert_eq!(
        ids(notes.notes_tagged("trip".into()).expect("tagged")),
        [NOTE]
    );
    assert_eq!(
        ids(notes.journals_tagged("trip".into()).expect("days")),
        [DAY]
    );
    let trip = notes.tags().expect("tags");
    assert_eq!(
        trip.iter()
            .map(|tag| (tag.name.as_str(), tag.note_count))
            .collect::<Vec<_>>(),
        [("trip", 1)],
        "the day is not a note carrying the tag"
    );

    // `[[2020-01-01]]` names the day, never a note.
    assert_eq!(
        notes.resolve_wiki_target(DATE.into()).expect("resolve"),
        None
    );
    let kind = vault
        .db_handle()
        .call_blocking(|conn| note_meta::resolve_wiki_target_kind(conn, DATE))
        .expect("resolve")
        .expect("a target");
    assert_eq!((kind.id.as_str(), kind.kind.as_str()), (DAY, "journal"));

    // The related-item picker lists notes only, and a linked day stays a day.
    let picker = vault
        .db_handle()
        .call_blocking(|conn| related_items::search(conn, "", 10))
        .expect("picker");
    assert_eq!(
        picker
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        [NOTE]
    );
    let linked = vault
        .db_handle()
        .call_blocking(|conn| related_items::resolve(conn, &[DAY.to_owned()], &[]))
        .expect("resolve");
    let related_items::LinkState::Present(day) = &linked[0].state else {
        panic!("the day resolves: {:?}", linked[0].state);
    };
    assert_eq!(day.journal_date.as_deref(), Some(DATE));
}

#[tokio::test]
async fn backlinks_read_the_day_as_a_journal_day() {
    let vault = pulled_vault().await;
    let index = Connection::open_in_memory().expect("an index");
    index
        .execute_batch(&format!(
            "CREATE TABLE note_links (source_id TEXT, target_id TEXT, target_title TEXT);
             INSERT INTO note_links VALUES ('{NOTE}', NULL, '{DAY}');
             INSERT INTO note_links VALUES ('{DAY}', '{NOTE}', 'Trip plan');"
        ))
        .expect("the links");
    let index = std::sync::Mutex::new(index);
    let (to_day, to_note) = vault
        .db_handle()
        .call_blocking(move |data| {
            let index = index.lock().expect("the index");
            Ok((
                links::backlinks(data, &index, DAY, BacklinkOrder::Recent)?,
                links::backlinks(data, &index, NOTE, BacklinkOrder::Recent)?,
            ))
        })
        .expect("backlinks");
    assert_eq!(
        to_day
            .iter()
            .map(|row| row.source_id.as_str())
            .collect::<Vec<_>>(),
        [NOTE],
        "a `[[j2020-01-01]]` link reaches the day"
    );
    assert_eq!(
        to_note
            .iter()
            .map(|row| (row.source_id.as_str(), row.source_kind.as_str()))
            .collect::<Vec<_>>(),
        [(DAY, "journal")]
    );
}

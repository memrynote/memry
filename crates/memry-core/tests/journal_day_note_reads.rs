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

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, error_response, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::calendar_records::CalendarZone;
use memry_core::api::crypto::derive_vault_key;
use memry_core::api::errors::TransportError;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::search::BacklinkOrder;
use memry_core::api::sync::{SyncPhase, SyncProgress, SyncProgressListener};
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crypto::sodium;
use memry_core::domain::calendar_items::projection::{self, RangeInput};
use memry_core::domain::journal_ops::{body, links};
use memry_core::domain::related_items;
use memry_core::domain::{folders, note_meta, notes as note_writes, tag_rename};
use memry_core::protocol::account::{AccountSealer, DeviceSigner};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope::SyncOperation;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::SyncItemRow;
use memry_core::sync::first_sync::RECENT_WINDOW_MS;
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

fn session(transport: Arc<dyn Transport>) -> Arc<AuthSession> {
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
    pulled_vault_reporting(None).await
}

async fn pulled_vault_reporting(progress: Option<Arc<dyn SyncProgressListener>>) -> Vault {
    first_sync(scripted(desktop_records(), OLD), progress).await
}

/// The first sync's script for `records`, each modified at `modified_at`.
fn scripted(records: Vec<(&str, &str, Json)>, modified_at: &str) -> Arc<FakeTransport> {
    let at = instants::to_epoch_ms(modified_at).expect("an instant");
    let items: Vec<Json> = records
        .iter()
        .map(|(kind, id, _)| {
            json!({ "id": id, "type": kind, "version": 1, "modifiedAt": at, "size": 12 })
        })
        .collect();
    let sealed: Vec<Json> = records
        .into_iter()
        .map(|(kind, id, mut payload)| {
            payload["createdAt"] = json!(modified_at);
            payload["modifiedAt"] = json!(modified_at);
            sealed(kind, id, payload)
        })
        .collect();
    FakeTransport::new(vec![
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
    ])
}

async fn first_sync(
    transport: Arc<dyn Transport>,
    progress: Option<Arc<dyn SyncProgressListener>>,
) -> Vault {
    let vault = scratch_vault();
    vault
        .sync(session(transport))
        .first_sync(progress)
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

/// Every `(item_type, op)` the outbox queued for the day, after `since`.
fn queued_for_day(vault: &Vault, since: i64) -> Vec<(String, String)> {
    vault
        .db_handle()
        .call_blocking(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT item_type, op FROM outbox WHERE item_id = ?1 AND id > ?2 ORDER BY id",
                )
                .expect("the outbox");
            Ok(statement
                .query_map(rusqlite::params![DAY, since], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .expect("rows")
                .collect::<Result<Vec<_>, _>>()
                .expect("rows"))
        })
        .expect("read")
}

fn outbox_tip(vault: &Vault) -> i64 {
    vault
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row("SELECT COALESCE(MAX(id), 0) FROM outbox", [], |row| {
                    row.get(0)
                })
                .expect("the tip"))
        })
        .expect("read")
}

/// A tag or title rename rewrites the day's body as the day's: a `note`
/// update under the day's id would land on desktop's attachment-carrying
/// note record instead of the journal body.
#[tokio::test]
async fn renames_rewrite_the_day_body_as_a_journal_update() {
    let vault = pulled_vault().await;
    vault
        .db_handle()
        .call_blocking(|conn| {
            body::edit_day(
                conn,
                DATE,
                &BlockEdit::InsertParagraph {
                    after_block_id: None,
                    text: "Packing #trip ".to_owned(),
                    new_block_id: "b1".to_owned(),
                },
                DEVICE,
                1,
            )
            .expect("the day's text");
            body::edit_day(
                conn,
                DATE,
                &BlockEdit::InsertInline {
                    block_id: "b1".to_owned(),
                    start: 14,
                    end: 14,
                    kind: "wikiLink".to_owned(),
                    text: String::new(),
                    attrs: HashMap::from([
                        ("target".to_owned(), "Trip plan".to_owned()),
                        ("alias".to_owned(), String::new()),
                    ]),
                },
                DEVICE,
                2,
            )
            .expect("the day's link");
            Ok(())
        })
        .expect("write the day");

    let tip = outbox_tip(&vault);
    vault
        .db_handle()
        .call_blocking(|conn| tag_rename::rename(conn, "trip", "voyage", DEVICE, 3))
        .expect("rename the tag");
    let tagged = queued_for_day(&vault, tip);
    assert!(
        tagged.contains(&("journal".to_owned(), "crdt-update".to_owned())),
        "the tag rename rewrote the day: {tagged:?}"
    );
    // The day's note record carries the tag too, so its metadata upsert is
    // the record's own; only the body must never go out as a note's.
    assert!(
        !tagged.contains(&("note".to_owned(), "crdt-update".to_owned())),
        "no body update queued as a note: {tagged:?}"
    );

    let tip = outbox_tip(&vault);
    vault
        .db_handle()
        .call_blocking(|conn| note_writes::rename(conn, NOTE, "Voyage plan", DEVICE, 4))
        .expect("rename the note");
    let relinked = queued_for_day(&vault, tip);
    assert_eq!(
        relinked,
        [("journal".to_owned(), "crdt-update".to_owned())],
        "the link re-point rewrote the day once, as the day"
    );
}

/// The calendar's "notes by created date" lists real notes only.
#[tokio::test]
async fn the_calendar_does_not_show_the_day_as_a_note() {
    let vault = pulled_vault().await;
    let zone = CalendarZone {
        identifier: "UTC".to_owned(),
        base_offset_ms: 0,
        transitions: Vec::new(),
    };
    let input = RangeInput {
        start_at: "2019-12-01T00:00:00.000Z".to_owned(),
        end_at: "2020-02-01T00:00:00.000Z".to_owned(),
        include_unselected_sources: true,
        include_external: false,
        external_providers: None,
        enabled_property_names: Vec::new(),
        show_notes_by_created: true,
        local_timezone: "UTC".to_owned(),
    };
    let items = vault
        .db_handle()
        .call_blocking(move |conn| projection::range(conn, &zone, &input))
        .expect("the range");
    assert_eq!(
        items
            .iter()
            .map(|item| item.source_id.as_str())
            .collect::<Vec<_>>(),
        [NOTE]
    );
}

struct Recorded(Mutex<Vec<SyncProgress>>);

impl SyncProgressListener for Recorded {
    fn progress(&self, progress: SyncProgress) {
        self.0.lock().unwrap().push(progress);
    }
}

/// First-sync body progress counts the day once: two documents, not three.
#[tokio::test]
async fn first_sync_counts_the_day_as_one_document() {
    let recorded = Arc::new(Recorded(Mutex::new(Vec::new())));
    pulled_vault_reporting(Some(recorded.clone())).await;
    let totals: Vec<Option<u64>> = recorded
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|tick| matches!(tick.phase, SyncPhase::Bodies))
        .map(|tick| tick.total)
        .collect();
    assert!(!totals.is_empty(), "a bodies tick");
    assert!(
        totals.iter().all(|total| *total == Some(2)),
        "the day and the note: {totals:?}"
    );
}

/// A task created inside the day links the day's id (desktop
/// `journal-handlers.ts`). Desktop's task note index is its notes list, which
/// holds no day, so the Location filter offers no note and no `journal` folder.
#[tokio::test]
async fn a_task_linked_to_the_day_has_no_note_location() {
    let vault = pulled_vault().await;
    let store = FakeSecureStore::new();
    let (_, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let tasks = vault.tasks(store).expect("tasks");
    let project = tasks
        .create_project(ProjectDraft {
            name: "Errands".to_owned(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .expect("a project");
    tasks
        .create(NewTaskInput {
            title: "Book the hotel".to_owned(),
            project_id: project,
            status_id: None,
            parent_id: None,
            priority: 0,
            description: None,
            due_date: None,
            due_time: None,
            start_date: None,
            repeat: None,
            repeat_from: None,
            tags: Vec::new(),
            linked_note_ids: vec![DAY.to_owned(), NOTE.to_owned()],
            linked_canvas_ids: Vec::new(),
            source_note_id: None,
            position: None,
        })
        .expect("a task");
    let options = tasks
        .location_options(Vec::new(), Vec::new(), String::new())
        .expect("options");
    assert_eq!(
        options
            .iter()
            .map(|option| (option.kind.as_str(), option.value.as_str()))
            .collect::<Vec<_>>(),
        [("note", NOTE)]
    );
}

/// `journal_entries.id` admits NULL (no `NOT NULL` on the key); a NULL id
/// must not empty the notes list the way `x NOT IN (…, NULL)` would.
#[tokio::test]
async fn a_null_journal_id_does_not_hide_every_note() {
    let vault = pulled_vault().await;
    vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO journal_entries (id, date) VALUES (NULL, '1999-01-01')",
                [],
            )
            .expect("a NULL id");
            Ok(())
        })
        .expect("write");
    let listed: Vec<String> = vault
        .notes()
        .list()
        .expect("list")
        .into_iter()
        .map(|row| row.id)
        .collect();
    assert_eq!(listed, [NOTE]);
}

/// The script for everything but the body pulls, which run concurrently and
/// so are answered by route: no snapshot and an empty log for every document.
struct BodiesByRoute {
    script: Arc<FakeTransport>,
    snapshots: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Transport for BodiesByRoute {
    async fn send(&self, request: HttpRequest) -> Scripted {
        let url = request.url.as_str();
        if url.contains("/sync/crdt/updates/batch") {
            http_fakes::probe_refused()
        } else if url.contains("/sync/crdt/snapshot/") {
            self.snapshots.lock().unwrap().push(request.url.clone());
            response(200, &json!({ "snapshot": null }).to_string())
        } else if url.contains("/sync/crdt/updates") {
            response(200, &json!({ "updates": [], "hasMore": false }).to_string())
        } else {
            self.script.send(request).await
        }
    }

    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        self.script.open_socket(request, listener)
    }
}

/// A recent day with a picture is one document in the first sync's window:
/// its `journal` row and its `notes` row must not take two of the window's
/// slots, nor pull the day's body twice.
#[tokio::test]
async fn first_sync_pulls_a_recent_day_once() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after the epoch")
        .as_millis() as i64;
    let yesterday = instants::to_iso8601(now - RECENT_WINDOW_MS / 30).expect("an instant");
    let transport = Arc::new(BodiesByRoute {
        script: scripted(desktop_records(), &yesterday),
        snapshots: Mutex::new(Vec::new()),
    });
    first_sync(transport.clone(), None).await;
    let snapshots = transport.snapshots.lock().unwrap().clone();
    let pulled = |id: &str| snapshots.iter().filter(|url| url.contains(id)).count();
    assert_eq!(
        (pulled(DAY), pulled(NOTE)),
        (1, 1),
        "each document pulled once: {snapshots:?}"
    );
}

/// Renaming a real folder named `journal` moves the folder's notes, never the
/// day's note record: desktop's folder move skips a journal day's row
/// (`moveIndexedNotesWithFolder`), and a day's path is never synced.
#[tokio::test]
async fn renaming_a_journal_folder_leaves_the_day_alone() {
    let vault = pulled_vault().await;
    let tip = outbox_tip(&vault);
    vault
        .db_handle()
        .call_blocking(|conn| {
            folders::create(conn, "journal", None, DEVICE, 5)?;
            folders::rename(conn, "journal", "Diary", DEVICE, 6)?;
            Ok(())
        })
        .expect("rename the folder");
    assert_eq!(
        queued_for_day(&vault, tip),
        [],
        "nothing queued for the day"
    );
    let folder: Option<String> = vault
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT folder_path FROM notes WHERE id = ?1",
                    [DAY],
                    |row| row.get(0),
                )
                .expect("the day's row"))
        })
        .expect("read");
    assert_eq!(folder.as_deref(), Some("journal"));
}

/// A folder holding only a journal day is still in use: desktop refuses to
/// move a folder onto an existing directory (`move-directory.ts`), and a
/// date-named note moved under `journal` would read there as a journal entry.
#[tokio::test]
async fn renaming_onto_a_folder_holding_only_a_day_is_refused() {
    let vault = pulled_vault().await;
    let refused = vault
        .db_handle()
        .call_blocking(|conn| {
            folders::create(conn, "Work", None, DEVICE, 5)?;
            Ok(folders::rename(conn, "Work", "journal", DEVICE, 6).is_err())
        })
        .expect("try the rename");
    assert!(refused, "`journal` holds the day's row, so it is in use");
}

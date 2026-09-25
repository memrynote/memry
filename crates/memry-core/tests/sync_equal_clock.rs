//! Chapter 06 §6.5.2 P4's identical-payload exception (#2294), and what it
//! asks of the cursor (chapter 05 §5.11).
//!
//! Real `HttpClient`, SQLite and repositories; the transport and the record
//! cipher are the only fakes.
//!
//! | Test                                      | Rule                               |
//! | ----------------------------------------- | ---------------------------------- |
//! | equal and identical writes nothing        | §6.5.2 P4, #2294                   |
//! | equal and different applies               | §6.5.2 P4                          |
//! | a page re-pulled after a crash            | §5.11, the cursor after apply      |
//! | a skipped record owes no body             | §5.11, the debt a page created     |

mod http_fakes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::domain::notes::{self, NewNote};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_debt;
use memry_core::sync::pull::{PullLoop, PullReport, RecordCipher};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::{Value as Json, json};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const NOTE: &str = "abc123def456";

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-equal-clock-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

struct ScriptedCipher(Mutex<Vec<(String, String)>>);

impl RecordCipher for ScriptedCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _)| id == &envelope.id)
            .map(|(_, payload)| payload.as_bytes().to_vec())
            .ok_or(EnvelopeError::SignatureInvalid)
    }
}

fn envelope(id: &str, item_type: &str) -> Json {
    json!({
        "id": id,
        "type": item_type,
        "operation": "update",
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-b",
    })
}

/// One `/sync/changes` page and its `/sync/pull`, each record opened to the
/// payload given.
async fn pull_page(db: &Db, records: &[(&str, &str, Json)], next_cursor: &str) -> PullReport {
    let refs: Vec<Json> = records
        .iter()
        .map(|(id, item_type, _)| json!({"id": id, "type": item_type}))
        .collect();
    let items: Vec<Json> = records
        .iter()
        .map(|(id, item_type, _)| envelope(id, item_type))
        .collect();
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": refs, "deleted": [], "hasMore": false, "nextCursor": next_cursor})
                .to_string(),
        ),
        response(200, &json!({ "items": items }).to_string()),
    ]);
    let cipher = ScriptedCipher(Mutex::new(
        records
            .iter()
            .map(|(id, _, payload)| ((*id).to_owned(), payload.to_string()))
            .collect(),
    ));
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(cipher),
    )
    .pull_page()
    .await
    .expect("the page")
}

fn note_payload(title: &str) -> Json {
    json!({
        "title": title,
        "fileType": "markdown",
        "folderPath": "Notes",
        "clock": {"device-b": 1}
    })
}

/// `sync_items.updated_at` and `notes.synced_at`: both move on every write.
fn write_marks(db: &Db) -> (i64, i64) {
    db.call_blocking(|conn| {
        let failed = |error: rusqlite::Error| StorageError::Failed {
            what: error.to_string(),
        };
        let updated: i64 = conn
            .query_row(
                "SELECT updated_at FROM sync_items WHERE item_type = 'note' AND item_id = ?1",
                [NOTE],
                |row| row.get(0),
            )
            .map_err(failed)?;
        let synced: i64 = conn
            .query_row("SELECT synced_at FROM notes WHERE id = ?1", [NOTE], |row| {
                row.get(0)
            })
            .map_err(failed)?;
        Ok((updated, synced))
    })
    .expect("read the write marks")
}

fn title(db: &Db) -> String {
    db.call_blocking(|conn| {
        conn.query_row("SELECT title FROM notes WHERE id = ?1", [NOTE], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("the note projection")
}

fn owed(db: &Db) -> Vec<String> {
    db.call_blocking(|conn| body_debt::owed(conn))
        .expect("the owed documents")
}

fn stored_cursor(db: &Db) -> Option<String> {
    db.call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("read the cursor")
}

/// #2294: the device's own row pulled back, or any row it already holds, is a
/// no-op: not counted as applied, and neither the record nor its projection
/// is rewritten.
#[tokio::test]
async fn an_equal_clock_with_an_identical_payload_is_skipped_and_writes_nothing() {
    let db = scratch_db("identical");
    let first = pull_page(&db, &[(NOTE, "note", note_payload("Same"))], "10").await;
    assert_eq!(first.applied, 1);
    let before = write_marks(&db);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    // Key order differs; §6.4.2's canonical form says it is the same payload.
    let reordered = json!({
        "clock": {"device-b": 1},
        "folderPath": "Notes",
        "fileType": "markdown",
        "title": "Same"
    });
    let second = pull_page(&db, &[(NOTE, "note", reordered)], "11").await;

    assert_eq!(second.skipped, 1, "{second:?}");
    assert_eq!(second.applied, 0);
    assert!(!second.refused, "a skip is work, not nothing");
    assert_eq!(write_marks(&db), before, "nothing was written");
    assert_eq!(stored_cursor(&db).as_deref(), Some("11"));
}

/// #2294, §6.5.2 P4 kept: an equal clock over a different payload is the
/// collided re-push that converges only because it applies.
#[tokio::test]
async fn an_equal_clock_with_a_different_payload_still_applies() {
    let db = scratch_db("different");
    pull_page(&db, &[(NOTE, "note", note_payload("Mine"))], "10").await;

    let report = pull_page(&db, &[(NOTE, "note", note_payload("Theirs"))], "11").await;

    assert_eq!(report.applied, 1, "{report:?}");
    assert_eq!(report.skipped, 0);
    assert_eq!(title(&db), "Theirs");
}

/// #2294, chapter 05 §5.11: a crash after the page's rows committed and
/// before its cursor did leaves the cursor on the previous page. The page is
/// pulled again, its rows are identical skips, and the body pull the first
/// apply owed is still owed, because a re-pull no longer re-applies the note.
#[tokio::test]
async fn a_page_re_pulled_after_a_crash_skips_its_rows_and_keeps_the_body_debt() {
    let db = scratch_db("crash");
    let page = [
        (NOTE, "note", note_payload("Crash")),
        (
            "task-1",
            "task",
            json!({"title": "Ship it", "clock": {"device-b": 1}}),
        ),
    ];
    let first = pull_page(&db, &page, "20").await;
    assert_eq!(first.applied, 2);
    assert_eq!(owed(&db), [NOTE], "the applied note is owed its body");

    // The crash: the rows committed, the cursor did not.
    db.call_blocking(|conn| store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some("10"), 1))
        .expect("roll the cursor back");

    let again = pull_page(&db, &page, "20").await;
    assert_eq!(again.skipped, 2, "{again:?}");
    assert_eq!(again.applied, 0);
    assert_eq!(stored_cursor(&db).as_deref(), Some("20"));
    assert_eq!(owed(&db), [NOTE], "the debt survives the re-pull");
}

/// #2294: a page owes a body only for the notes it wrote. A stale record it
/// skipped takes back the debt it created, so a re-pull of the whole feed
/// does not owe every note in the vault.
#[tokio::test]
async fn a_skipped_note_record_owes_no_body_pull() {
    let db = scratch_db("stale");
    db.call_blocking(|conn| {
        notes::create(
            conn,
            &NewNote {
                id: NOTE,
                title: "Local",
                folder_path: Some("Notes"),
                content: "",
                tags: &[],
                properties: None,
            },
            "device-a",
            1_760_000_000_000,
        )?;
        notes::rename(conn, NOTE, "Newer", "device-a", 1_760_000_001_000)?;
        Ok(())
    })
    .expect("the local note");

    let stale = json!({
        "title": "Stale",
        "fileType": "markdown",
        "folderPath": "Notes",
        "clock": {"device-a": 1}
    });
    let report = pull_page(&db, &[(NOTE, "note", stale)], "30").await;

    assert_eq!(report.skipped, 1, "{report:?}");
    assert!(owed(&db).is_empty(), "{:?}", owed(&db));
}

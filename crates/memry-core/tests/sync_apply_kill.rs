//! A record pull killed mid-chunk resumes with no lost and no duplicated row
//! (#5231, crates/AGENTS.md "Storage and keys").
//!
//! The parent test runs the pull in a child process (this same test binary)
//! that aborts while the second page is being written: no unwinding, no
//! rollback, exactly what the OS does to a backgrounded app. The parent then
//! reopens the database, checks the second page left nothing behind, and
//! resumes from the stored cursor.

mod http_fakes;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use http_fakes::{FakeTransport, response};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde_json::json;

const PAGES: usize = 3;
const PER_PAGE: usize = 100;
const PULL_IDS: usize = 100;
/// The child aborts on this `sync_items` write: the 50th row of page two.
const ABORT_AT_WRITE: usize = PER_PAGE + 50;
const CHILD_DIR: &str = "MEMRY_KILL_CHILD_DIR";

/// Answers each record's payload from its id; the crypto is not under test.
struct PayloadById;

impl RecordCipher for PayloadById {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(json!({
            "title": format!("Note {}", envelope.id),
            "tags": ["kill", envelope.id],
            "clock": { "remote-device": 1 },
        })
        .to_string()
        .into_bytes())
    }
}

fn note_id(index: usize) -> String {
    format!("k{index:011}")
}

/// `/sync/changes` then `/sync/pull` for every page from `first_page` on.
fn script(first_page: usize) -> Vec<String> {
    let mut script = Vec::new();
    for page in first_page..PAGES {
        let ids: Vec<usize> = (page * PER_PAGE..(page + 1) * PER_PAGE).collect();
        let refs: Vec<_> = ids
            .iter()
            .map(|index| json!({ "id": note_id(*index), "type": "note" }))
            .collect();
        script.push(
            json!({
                "items": refs,
                "deleted": [],
                "hasMore": page + 1 < PAGES,
                "nextCursor": ((page + 1) * PER_PAGE).to_string(),
            })
            .to_string(),
        );
        for chunk in ids.chunks(PULL_IDS) {
            let items: Vec<_> = chunk
                .iter()
                .map(|index| {
                    json!({
                        "id": note_id(*index),
                        "type": "note",
                        "operation": "update",
                        "encryptedKey": "AAAA",
                        "keyNonce": "AAAA",
                        "encryptedData": "AAAA",
                        "dataNonce": "AAAA",
                        "signature": "AAAA",
                        "signerDeviceId": "device-a",
                        "serverCursor": *index as i64 + 1,
                    })
                })
                .collect();
            script.push(json!({ "items": items }).to_string());
        }
    }
    script
}

fn pull_loop(db: &Db, first_page: usize) -> PullLoop {
    let transport = FakeTransport::new(
        script(first_page)
            .iter()
            .map(|body| response(200, body))
            .collect(),
    );
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(PayloadById),
    )
}

fn count(db: &Db, sql: &'static str) -> i64 {
    db.call_blocking(|conn| Ok(conn.query_row(sql, [], |row| row.get(0)).expect(sql)))
        .expect("count")
}

fn cursor(db: &Db) -> Option<String> {
    db.call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("read the cursor")
}

static WRITES: AtomicUsize = AtomicUsize::new(0);

fn abort_mid_chunk(event: TraceEvent<'_>) {
    let TraceEvent::Stmt(_, sql) = event else {
        return;
    };
    if sql.trim_start().starts_with("INSERT INTO sync_items")
        && WRITES.fetch_add(1, Ordering::SeqCst) + 1 == ABORT_AT_WRITE
    {
        std::process::abort();
    }
}

/// The child half: pulls every page and dies inside page two. A no-op unless
/// the parent started it.
#[tokio::test]
#[ignore = "the child process of the kill test"]
async fn child_pulls_until_killed() {
    let Ok(dir) = std::env::var(CHILD_DIR) else {
        return;
    };
    let db = open_data(&Path::new(&dir).join("data.db")).expect("open data.db");
    db.call(|conn| {
        conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(abort_mid_chunk));
        Ok(())
    })
    .await
    .expect("install the trace");
    let _ = pull_loop(&db, 0).run(u32::MAX).await;
    unreachable!("the child aborts inside page two");
}

#[tokio::test]
async fn a_pull_killed_mid_chunk_resumes_with_no_lost_and_no_duplicated_row() {
    let dir: PathBuf =
        std::env::temp_dir().join(format!("memry-apply-kill-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the scratch directory");

    let status = Command::new(std::env::current_exe().expect("this test binary"))
        .args([
            "--exact",
            "child_pulls_until_killed",
            "--ignored",
            "--nocapture",
        ])
        .env(CHILD_DIR, &dir)
        .status()
        .expect("run the child");
    assert!(
        !status.success(),
        "the child must die mid-chunk, got {status}"
    );

    let db = open_data(&dir.join("data.db")).expect("reopen data.db");
    assert_eq!(
        cursor(&db).as_deref(),
        Some("100"),
        "the cursor names page one, the last page that committed"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM sync_items"),
        PER_PAGE as i64,
        "page two committed atomically with its cursor or not at all"
    );
    assert_eq!(count(&db, "SELECT COUNT(*) FROM notes"), PER_PAGE as i64);

    let report = pull_loop(&db, 1)
        .run(u32::MAX)
        .await
        .expect("the resumed pull");
    assert_eq!(report.applied, (PAGES - 1) * PER_PAGE);
    assert_eq!(report.corrupt, 0);
    assert_eq!(cursor(&db).as_deref(), Some("300"));

    let total = (PAGES * PER_PAGE) as i64;
    assert_eq!(count(&db, "SELECT COUNT(*) FROM sync_items"), total);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(DISTINCT item_id) FROM sync_items WHERE item_type = 'note'"
        ),
        total
    );
    assert_eq!(count(&db, "SELECT COUNT(*) FROM notes"), total);
    assert_eq!(count(&db, "SELECT COUNT(DISTINCT id) FROM notes"), total);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM note_tags"), 2 * total);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM (SELECT DISTINCT note_id, tag FROM note_tags)"
        ),
        2 * total
    );
}

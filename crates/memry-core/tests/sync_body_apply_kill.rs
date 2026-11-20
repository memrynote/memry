//! A body apply killed mid-chunk resumes with no lost and no duplicated body
//! row (#5231, crates/AGENTS.md "Storage and keys").
//!
//! As in `sync_apply_kill.rs`, the parent re-runs this binary as a child that
//! aborts inside the second chunk (no unwinding, no rollback), then reopens
//! the database, checks the chunk left nothing behind its cursor, and resumes.
//! Two chunks are covered: a pack's baselines (`PACK_SEED_CHUNK` per
//! transaction) and a document's page of updates.

mod http_fakes;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, bytes_response, mpak, response};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PACK_SEED_CHUNK, PackedUpdate};
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::pack_bootstrap::{META_PACKS_COMPLETED, PackBootstrap};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde_json::json;

const PACK_ENTRIES: usize = 3 * PACK_SEED_CHUNK;
const PAGES: i64 = 3;
const PER_PAGE: i64 = 100;
const DOC: &str = "killdoc00001";
const CHILD_DIR: &str = "MEMRY_BODY_KILL_DIR";
const CHILD_MODE: &str = "MEMRY_BODY_KILL_MODE";

/// The bytes are the body; signatures are not under test.
struct PassThrough;

impl CrdtCipher for PassThrough {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.packed.to_vec())
    }

    fn signer_candidates(&self) -> Vec<String> {
        vec!["device-a".into()]
    }
}

fn doc_id(index: usize) -> String {
    format!("p{index:011}")
}

fn bodies(db: &Db, script: Vec<String>, pack: Option<Vec<u8>>) -> (Arc<HttpClient>, Arc<BodyPull>) {
    let mut responses: Vec<_> = script.iter().map(|body| response(200, body)).collect();
    if let Some(pack) = pack {
        responses.push(bytes_response(pack));
    }
    let http = Arc::new(HttpClient::new(
        FakeTransport::new(responses),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    let pull = Arc::new(BodyPull::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(PassThrough),
    ));
    (http, pull)
}

async fn seed_packs(db: &Db) -> memry_core::sync::pack_bootstrap::PackBootstrapReport {
    let entries: Vec<(String, Option<serde_json::Value>, Vec<u8>)> = (0..PACK_ENTRIES)
        .map(|index| {
            let meta = json!({ "sequenceNum": 5, "revision": format!("rev-{index}") });
            (
                doc_id(index),
                Some(meta),
                format!("body {index}").into_bytes(),
            )
        })
        .collect();
    let entries: Vec<_> = entries
        .iter()
        .map(|(id, meta, bytes)| (id.as_str(), meta.clone(), bytes.clone()))
        .collect();
    let listing = json!({
        "packs": [{
            "id": "p1", "itemKind": "crdt_snapshot", "packKey": "k", "minCursor": 1,
            "maxCursor": 40, "itemCount": PACK_ENTRIES, "byteSize": 1, "createdAt": 1,
            "url": "https://r2.example/packs/p1", "expiresAt": 4_000_000_000i64
        }],
        "serverTime": 1
    })
    .to_string();
    let (http, pull) = bodies(db, vec![listing], Some(mpak(&entries)));
    PackBootstrap::new(http, db.clone(), pull)
        .run(1_000)
        .await
        .expect("the pack bootstrap")
}

/// The document's update pages from `since` on, after the snapshot GET a
/// cursor of `0` sends first.
fn update_script(since: i64) -> Vec<String> {
    let mut script = Vec::new();
    if since == 0 {
        script.push(json!({ "snapshot": null }).to_string());
    } else {
        // The probe of a document that holds a cursor: an old server's answer.
        script.push(json!({ "notes": {} }).to_string());
    }
    let mut from = since;
    while from < PAGES * PER_PAGE {
        let updates: Vec<_> = (from + 1..=from + PER_PAGE)
            .map(|seq| json!({ "sequenceNum": seq, "data": BASE64.encode(format!("u{seq}")) }))
            .collect();
        from += PER_PAGE;
        script.push(json!({ "updates": updates, "hasMore": from < PAGES * PER_PAGE }).to_string());
    }
    script
}

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("memry-body-kill-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    dir
}

fn count(db: &Db, sql: &'static str) -> i64 {
    db.call_blocking(|conn| Ok(conn.query_row(sql, [], |row| row.get(0)).expect(sql)))
        .expect("count")
}

static WRITES: AtomicUsize = AtomicUsize::new(0);
static ABORT_TABLE: std::sync::OnceLock<(&'static str, usize)> = std::sync::OnceLock::new();

fn abort_mid_chunk(event: TraceEvent<'_>) {
    let TraceEvent::Stmt(_, sql) = event else {
        return;
    };
    let (table, at) = ABORT_TABLE.get().expect("the abort point");
    if sql.trim_start().starts_with(table) && WRITES.fetch_add(1, Ordering::SeqCst) + 1 == *at {
        std::process::abort();
    }
}

/// The child half: applies until it dies in the second chunk. A no-op unless
/// the parent started it.
#[tokio::test]
#[ignore = "the child process of the kill tests"]
async fn child_applies_bodies_until_killed() {
    let Ok(dir) = std::env::var(CHILD_DIR) else {
        return;
    };
    let pack = std::env::var(CHILD_MODE).as_deref() == Ok("pack");
    let abort_at = if pack {
        ("INSERT INTO yjs_snapshots", PACK_SEED_CHUNK + 50)
    } else {
        ("INSERT OR IGNORE INTO yjs_updates", PER_PAGE as usize + 50)
    };
    ABORT_TABLE.set(abort_at).expect("set once");
    let db = open_data(&Path::new(&dir).join("data.db")).expect("open data.db");
    db.call(|conn| {
        conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(abort_mid_chunk));
        Ok(())
    })
    .await
    .expect("install the trace");
    if pack {
        seed_packs(&db).await;
    } else {
        let _ = bodies(&db, update_script(0), None)
            .1
            .pull_document(DOC)
            .await;
    }
    unreachable!("the child aborts inside the second chunk");
}

fn kill_child(label: &str, mode: &str) -> Db {
    let dir = scratch(label);
    let status = Command::new(std::env::current_exe().expect("this test binary"))
        .args([
            "--exact",
            "child_applies_bodies_until_killed",
            "--ignored",
            "--nocapture",
        ])
        .env(CHILD_DIR, &dir)
        .env(CHILD_MODE, mode)
        .status()
        .expect("run the child");
    assert!(
        !status.success(),
        "the child must die mid-chunk, got {status}"
    );
    open_data(&dir.join("data.db")).expect("reopen data.db")
}

#[tokio::test]
async fn a_pack_seed_killed_mid_chunk_resumes_with_every_baseline_once() {
    let db = kill_child("pack", "pack");
    let chunk = PACK_SEED_CHUNK as i64;
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM yjs_snapshots"),
        chunk,
        "the second chunk committed with its cursors or not at all"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM sync_cursors WHERE scope LIKE 'crdt:%' AND cursor = '5'"
        ),
        chunk,
        "every stored baseline holds its cursor, and no cursor leads its baseline"
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM yjs_snapshots s JOIN sync_cursors c ON c.scope = 'crdt:' || s.doc_id"
        ),
        chunk
    );
    let completed = db
        .call_blocking(|conn| read_meta(conn, META_PACKS_COMPLETED))
        .expect("meta");
    assert_eq!(completed, None, "a pack killed part way is not completed");

    let report = seed_packs(&db).await;
    assert_eq!(report.packs_applied, 1);
    assert_eq!(report.entries_applied, PACK_ENTRIES - PACK_SEED_CHUNK);
    assert_eq!(
        report.entries_skipped, PACK_SEED_CHUNK,
        "the first chunk is not seeded twice"
    );

    let total = PACK_ENTRIES as i64;
    assert_eq!(count(&db, "SELECT COUNT(*) FROM yjs_snapshots"), total);
    assert_eq!(
        count(&db, "SELECT COUNT(DISTINCT doc_id) FROM yjs_snapshots"),
        total
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM sync_cursors WHERE scope LIKE 'crdt:%' AND cursor = '5'"
        ),
        total
    );
}

#[tokio::test]
async fn a_body_pull_killed_mid_page_resumes_with_every_update_once() {
    let db = kill_child("page", "page");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM yjs_updates"),
        PER_PAGE,
        "page two committed with its cursor or not at all"
    );
    let cursor = |db: &Db| {
        db.call_blocking(|conn| memry_core::sync::store::read_cursor(conn, &format!("crdt:{DOC}")))
            .expect("the cursor")
    };
    assert_eq!(
        cursor(&db).as_deref(),
        Some("100"),
        "the cursor names page one"
    );

    let report = bodies(&db, update_script(PER_PAGE), None)
        .1
        .pull_document(DOC)
        .await
        .expect("the resumed pull");
    assert!(report.merged());
    assert_eq!(report.updates as i64, (PAGES - 1) * PER_PAGE);
    assert_eq!(cursor(&db).as_deref(), Some("300"));
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM yjs_updates"),
        PAGES * PER_PAGE
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM (SELECT DISTINCT doc_id, seq FROM yjs_updates)"
        ),
        PAGES * PER_PAGE
    );
    assert_eq!(count(&db, "SELECT MIN(seq) FROM yjs_updates"), 1);
    assert_eq!(
        count(&db, "SELECT MAX(seq) FROM yjs_updates"),
        PAGES * PER_PAGE
    );
}

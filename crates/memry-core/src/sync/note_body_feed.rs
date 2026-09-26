//! Note and journal bodies from the change feed, chapter 07 §7.17 and
//! chapter 05 §5.11.1 (#2295, #2297, #2304).
//!
//! A pull that declares `note_body` gets a page's body rows in `noteBodies`,
//! on the same cursor as its records. Two halves, split by what may fail:
//!
//! - [`fetch`] runs **before** the page applies and does the network work:
//!   each entry parsed on its own, a ref fetched, the envelope opened, the
//!   update parsed. Any failure costs that entry and makes its document owed
//!   a per-note pull ([`super::body_debt`]); it never fails the page. Entries
//!   for a document this device holds no body for, and replays below the held
//!   cursor, cost no request at all.
//! - [`land_and_advance`] is **one transaction**: the bodies stored, the
//!   debts recorded, then the record cursor. A body that cannot land is owed
//!   before the cursor moves past it, and a storage failure rolls the whole
//!   thing back with the cursor unmoved (§5.11).
//!
//! Landing appends to the server namespace of the update log, the same rows
//! [`super::body_pull`] writes; a resident document merges them on its next
//! load. The per-document `crdt:<docId>` cursor moves only over a contiguous
//! sequence: an update past a gap is stored and its document owed, so the
//! whole-body pull still fetches the missing ones (§7.9).

use std::collections::{HashMap, HashSet};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, params};
use serde_json::Value as Json;
use yrs::Update;
use yrs::updates::decoder::Decode as _;

use crate::api::errors::{ApiError, StorageError};
use crate::crdt::update_log::{self, Namespace};
use crate::protocol::http::{ApiRequest, HttpClient, RetryPolicy};

use super::body_debt;
use super::body_pull::{CrdtCipher, PackedUpdate, crdt_cursor_scope};
use super::crdt_wire::read_update_page;
use super::first_sync_store::{read_meta, write_meta};
use super::store::{self, RECORD_CURSOR_SCOPE};

/// The feed-only token a client adds to `X-Memry-Sync-Types` (§5.3).
pub const NOTE_BODY_SYNC_TYPE: &str = "note_body";

/// The one-time legacy pull: absent until a server first serves
/// `noteBodies`, then `done` in the same transaction that owes a body pull to
/// every document this device holds body state for. The feed never serves a
/// row written before migration `0011` (§7.17), and a device that never
/// fetched a document fetches it whole when it is opened, so only held
/// documents can be missing state. The debts carry the progress.
pub const META_NOTE_BODY_LEGACY_PULL: &str = "sync.note_body_legacy_pull";

/// One body ready to store.
pub(super) enum Landing {
    Update {
        doc_id: String,
        sequence_num: i64,
        update: Vec<u8>,
    },
    Snapshot {
        doc_id: String,
        sequence_num: i64,
        revision: Option<String>,
        snapshot: Vec<u8>,
    },
}

/// What [`fetch`] produced for one page.
#[derive(Default)]
pub(super) struct FetchedBodies {
    pub(super) landings: Vec<Landing>,
    /// Documents an entry of this page could not deliver.
    pub(super) owed: Vec<String>,
    /// The page carried `noteBodies` at all, so the server serves bodies.
    pub(super) served: bool,
}

/// The request builder and client [`fetch`] sends through, so its requests
/// carry the pull's own headers.
pub(super) struct FeedClient<'a> {
    pub(super) http: &'a HttpClient,
    pub(super) request: &'a (dyn Fn(&str, &str) -> ApiRequest + Sync),
    pub(super) cipher: &'a dyn CrdtCipher,
}

/// Parses, fetches, opens and parses each entry of `noteBodies`.
///
/// Three kinds of entry cost nothing at all, no request and no decrypt:
///
/// - one for an id in `dropped`, a note or journal this page deletes
///   (§7.17.1: the client drops bodies for a tombstoned id itself);
/// - one for a document this device holds no body state for
///   ([`HeldBodies::known`]). Its body was never fetched here, so it is
///   fetched whole when it is opened or when its record arrives; storing a
///   feed row for it would leave a partial body that reads as present;
/// - an update at or below the held `crdt:<docId>` cursor, which is a replay
///   (§7.9).
///
/// After the first `429` of a page no further request is sent: every entry
/// still needing one owes its document instead.
pub(super) async fn fetch(
    client: &FeedClient<'_>,
    entries: Option<&[Json]>,
    dropped: &[String],
    held: &HeldBodies,
) -> FetchedBodies {
    let mut fetched = FetchedBodies {
        served: entries.is_some(),
        ..FetchedBodies::default()
    };
    let mut rate_limited = false;
    for entry in entries.unwrap_or_default() {
        let Some(doc_id) = entry.get("noteId").and_then(Json::as_str) else {
            continue;
        };
        if dropped.iter().any(|id| id == doc_id) || !held.known.contains(doc_id) {
            continue;
        }
        let outcome = match entry.get("op").and_then(Json::as_str) {
            Some("update") => {
                let at = held.cursors.get(doc_id).copied().unwrap_or(0);
                match entry.get("sequenceNum").and_then(Json::as_i64) {
                    Some(sequence_num) if sequence_num <= at => continue,
                    Some(sequence_num) => {
                        fetch_update(client, doc_id, sequence_num, entry, rate_limited).await
                    }
                    None => Fetched::Owed,
                }
            }
            Some("snapshot") => {
                let revision = entry.get("revision").and_then(Json::as_str);
                if revision.is_some() && revision == held.revisions.get(doc_id).map(String::as_str)
                {
                    continue;
                }
                if rate_limited {
                    Fetched::Owed
                } else {
                    fetch_snapshot(client, doc_id).await
                }
            }
            _ => Fetched::Owed,
        };
        match outcome {
            Fetched::Landed(landing) => fetched.landings.push(landing),
            Fetched::Owed => fetched.owed.push(doc_id.to_owned()),
            Fetched::RateLimited => {
                rate_limited = true;
                fetched.owed.push(doc_id.to_owned());
            }
        }
    }
    fetched
}

/// One entry's outcome.
enum Fetched {
    Landed(Landing),
    /// Anything that did not yield a parsed body, including a ref the server
    /// pruned (§7.17.2).
    Owed,
    /// A `429`: owed, and the page sends no further request.
    RateLimited,
}

/// A request's failure, read for the one answer that changes the rest of the
/// page.
fn failed_fetch(error: &ApiError) -> Fetched {
    if matches!(error, ApiError::RateLimited { .. }) {
        Fetched::RateLimited
    } else {
        Fetched::Owed
    }
}

/// An update entry: its inline `data`, or one fetch by sequence when it came
/// as a ref.
async fn fetch_update(
    client: &FeedClient<'_>,
    doc_id: &str,
    sequence_num: i64,
    entry: &Json,
    rate_limited: bool,
) -> Fetched {
    let (data, signer) = match entry.get("data").and_then(Json::as_str) {
        Some(data) => (
            data.to_owned(),
            entry
                .get("signerDeviceId")
                .and_then(Json::as_str)
                .map(str::to_owned),
        ),
        None if rate_limited => return Fetched::Owed,
        None => {
            let since = sequence_num - 1;
            let path = format!("/sync/crdt/updates?note_id={doc_id}&since={since}&limit=1");
            let request = (client.request)("GET", &path).retry(RetryPolicy::polled());
            let body: Json = match client.http.send_json(request).await {
                Ok(body) => body,
                Err(error) => return failed_fetch(&error),
            };
            let page = read_update_page(&body, doc_id);
            let Some(found) = page
                .updates
                .into_iter()
                .find(|update| update.sequence_num == sequence_num)
            else {
                return Fetched::Owed;
            };
            (found.data, found.signer_device_id)
        }
    };
    let Some(update) = open(client, doc_id, signer.as_deref(), &data) else {
        return Fetched::Owed;
    };
    Fetched::Landed(Landing::Update {
        doc_id: doc_id.to_owned(),
        sequence_num,
        update,
    })
}

/// A snapshot entry is always a ref: `GET /sync/crdt/snapshot/:id`, which may
/// answer a newer snapshot than the entry names (§7.17.1).
async fn fetch_snapshot(client: &FeedClient<'_>, doc_id: &str) -> Fetched {
    let request = (client.request)("GET", &format!("/sync/crdt/snapshot/{doc_id}"))
        .retry(RetryPolicy::polled());
    let body: Json = match client.http.send_json(request).await {
        Ok(body) => body,
        Err(error) => return failed_fetch(&error),
    };
    let landed = (|| {
        let encoded = body.get("snapshot").and_then(Json::as_str)?;
        let signer = body.get("signerDeviceId").and_then(Json::as_str);
        let snapshot = open(client, doc_id, signer, encoded)?;
        Some(Landing::Snapshot {
            doc_id: doc_id.to_owned(),
            sequence_num: body.get("sequenceNum").and_then(Json::as_i64)?,
            revision: body
                .get("revision")
                .and_then(Json::as_str)
                .map(str::to_owned),
            snapshot,
        })
    })();
    landed.map_or(Fetched::Owed, Fetched::Landed)
}

/// Decodes, opens and **parses** one packed body, so nothing unparseable is
/// ever stored.
fn open(
    client: &FeedClient<'_>,
    doc_id: &str,
    signer: Option<&str>,
    data: &str,
) -> Option<Vec<u8>> {
    let packed = BASE64.decode(data).ok()?;
    let opened = client
        .cipher
        .open(&PackedUpdate {
            doc_id,
            signer_device_id: signer,
            packed: &packed,
        })
        .ok()?;
    Update::decode_v1(&opened).ok()?;
    Some(opened)
}

/// What this device holds for the documents a page's entries name, read
/// before [`fetch`] so a replay or a held snapshot costs no request.
#[derive(Default)]
pub(super) struct HeldBodies {
    /// The documents with a `crdt:<docId>` cursor or a row in either
    /// namespace of the update log: the only ones the feed lands bodies for.
    pub(super) known: HashSet<String>,
    /// `crdt:<docId>`, where one is stored.
    pub(super) cursors: HashMap<String, i64>,
    /// The server snapshot revision, where one is stored.
    pub(super) revisions: HashMap<String, String>,
}

pub(super) fn held_bodies(
    conn: &Connection,
    entries: Option<&[Json]>,
) -> Result<HeldBodies, StorageError> {
    let mut held = HeldBodies::default();
    for entry in entries.unwrap_or_default() {
        let Some(doc_id) = entry.get("noteId").and_then(Json::as_str) else {
            continue;
        };
        if held.known.contains(doc_id) {
            continue;
        }
        let cursor = store::read_cursor(conn, &crdt_cursor_scope(doc_id))?;
        let has_rows = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM yjs_updates WHERE doc_id IN (?1, ?2))
                     OR EXISTS (SELECT 1 FROM yjs_snapshots WHERE doc_id IN (?1, ?2))",
                params![
                    Namespace::Server.row_id(doc_id),
                    Namespace::Local.row_id(doc_id)
                ],
                |row| row.get::<_, bool>(0),
            )
            .map_err(sqlite_failed)?;
        if cursor.is_none() && !has_rows {
            continue;
        }
        held.known.insert(doc_id.to_owned());
        if let Some(at) = cursor.and_then(|text| text.parse::<i64>().ok()) {
            held.cursors.insert(doc_id.to_owned(), at);
        }
        let revision = update_log::snapshot(conn, Namespace::Server, doc_id)
            .map_err(crdt_failed)?
            .and_then(|row| row.server_revision);
        if let Some(revision) = revision {
            held.revisions.insert(doc_id.to_owned(), revision);
        }
    }
    Ok(held)
}

/// Stores the page's bodies, records its debts, marks the legacy pull due on
/// the first page that served bodies, and writes the record cursor last, in
/// one transaction. Answers the documents whose log gained a body.
pub(super) fn land_and_advance(
    conn: &Connection,
    fetched: FetchedBodies,
    cursor: Option<&str>,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
    let mut advanced: Vec<String> = Vec::new();
    for landing in fetched.landings {
        let doc_id = match &landing {
            Landing::Update { doc_id, .. } | Landing::Snapshot { doc_id, .. } => doc_id.clone(),
        };
        if body_debt::is_deleted_document(&txn, &doc_id)? {
            continue;
        }
        let scope = crdt_cursor_scope(&doc_id);
        let at = store::read_cursor(&txn, &scope)?
            .and_then(|text| text.parse::<i64>().ok())
            .unwrap_or(0);
        match landing {
            Landing::Update {
                sequence_num,
                update,
                ..
            } => {
                if sequence_num <= at {
                    continue;
                }
                // Stamped with this device's clock, as the per-note pull does:
                // the search index re-reads log rows newer than its own
                // epoch-ms watermark (`domain::search::maintenance`).
                update_log::append_server_update(&txn, &doc_id, sequence_num, &update, now_ms)
                    .map_err(crdt_failed)?;
                if sequence_num == at + 1 {
                    store::write_cursor(&txn, &scope, Some(&sequence_num.to_string()), now_ms)?;
                } else {
                    body_debt::owe(&txn, &doc_id)?;
                }
            }
            Landing::Snapshot {
                sequence_num,
                revision,
                snapshot,
                ..
            } => {
                update_log::put_server_snapshot(
                    &txn,
                    &doc_id,
                    &snapshot,
                    sequence_num,
                    revision.as_deref(),
                    now_ms,
                )
                .map_err(crdt_failed)?;
                if sequence_num > at {
                    store::write_cursor(&txn, &scope, Some(&sequence_num.to_string()), now_ms)?;
                }
            }
        }
        if !advanced.contains(&doc_id) {
            advanced.push(doc_id);
        }
    }
    for doc_id in &fetched.owed {
        if !body_debt::is_deleted_document(&txn, doc_id)? {
            body_debt::owe(&txn, doc_id)?;
        }
    }
    // The one-time legacy pull, as debts: every held document is owed once,
    // and the pass's body step works them off with per-document progress.
    if fetched.served && read_meta(&txn, META_NOTE_BODY_LEGACY_PULL)?.is_none() {
        for doc_id in documents_with_body_state(&txn)? {
            body_debt::owe(&txn, &doc_id)?;
        }
        write_meta(&txn, META_NOTE_BODY_LEGACY_PULL, "done")?;
    } else if !fetched.served && store::read_cursor(&txn, RECORD_CURSOR_SCOPE)?.as_deref() != cursor
    {
        rearm_legacy_pull(&txn)?;
    }
    // §5.11: last, after every body of the page landed or was owed.
    store::write_cursor(&txn, RECORD_CURSOR_SCOPE, cursor, now_ms)?;
    txn.commit().map_err(sqlite_failed)?;
    Ok(advanced)
}

/// #2299: a writer that moves the record cursor past body rows it never
/// served (a page without `noteBodies`, the first sync's refs pass) leaves a
/// cursor that no longer covers every body below it. Re-arming the legacy pull
/// withholds `coversThrough` until a page that serves bodies owes every held
/// document again.
pub(super) fn rearm_legacy_pull(conn: &Connection) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![META_NOTE_BODY_LEGACY_PULL],
    )
    .map_err(sqlite_failed)?;
    Ok(())
}

/// The `coversThrough` a snapshot push of `doc_id` may claim (chapter 07
/// §7.7.1, #2299): the record cursor, once the legacy pull is `done`, for a
/// document whose server body this device has read (a `crdt:` cursor or a
/// server snapshot). Every body row at or below it then landed in the log, or
/// its document is owed, and an owed document never pushes. A document the
/// legacy pull never owed, because it held no body state then, claims
/// nothing. `None` is the pre-#2299 push.
pub fn covers_through(conn: &Connection, doc_id: &str) -> Result<Option<i64>, StorageError> {
    if read_meta(conn, META_NOTE_BODY_LEGACY_PULL)?.as_deref() != Some("done") {
        return Ok(None);
    }
    let read_server_body = store::read_cursor(conn, &crdt_cursor_scope(doc_id))?.is_some()
        || update_log::snapshot(conn, Namespace::Server, doc_id)
            .map_err(crdt_failed)?
            .is_some();
    if !read_server_body {
        return Ok(None);
    }
    Ok(store::read_cursor(conn, RECORD_CURSOR_SCOPE)?
        .and_then(|cursor| cursor.parse::<i64>().ok())
        .filter(|cursor| *cursor > 0))
}

/// Every live document this device holds body state for: a body cursor, or a
/// row in either namespace of the update log.
fn documents_with_body_state(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id FROM (
               SELECT substr(scope, 6) AS id FROM sync_cursors WHERE scope LIKE 'crdt:%'
               UNION SELECT doc_id FROM yjs_updates UNION SELECT doc_id FROM yjs_snapshots
             )
             WHERE id NOT LIKE 'local.%'
             UNION
             SELECT substr(doc_id, 7) FROM yjs_updates WHERE doc_id LIKE 'local.%'
             UNION
             SELECT substr(doc_id, 7) FROM yjs_snapshots WHERE doc_id LIKE 'local.%'
             ORDER BY 1",
        )
        .map_err(sqlite_failed)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_failed)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(sqlite_failed)?;
    let mut live = Vec::with_capacity(ids.len());
    for id in ids {
        if !body_debt::is_deleted_document(conn, &id)? {
            live.push(id);
        }
    }
    Ok(live)
}

fn crdt_failed(error: crate::crdt::CrdtError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn sqlite_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

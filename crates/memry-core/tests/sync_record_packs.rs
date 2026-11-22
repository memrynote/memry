//! A fresh device takes its records from `record` packs, tails the feed from
//! where the packs end, and closes with the cursor-exact manifest reconcile
//! (chapter 08 §8.4.2, §8.10, #5232).
//!
//! Real `HttpClient`, SQLite, pack reader, decode and apply. The fake is the
//! `Transport`, answering by route so parallel pack downloads need no script
//! order, and the record cipher, which answers a payload per id.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::http_fakes::{body_json, bytes_response, response};
use memry_core::api::errors::TransportError;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::first_sync::{FirstSync, FirstSyncError, FirstSyncReport};
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::pack_bootstrap::{META_RECORD_PACKS_DONE, PackBootstrap};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use serde_json::{Value as Json, json};
use sha2::{Digest as _, Sha256};
use tokio::sync::Notify;

fn scratch_db(label: &str) -> Db {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix(&format!("memry-record-packs-{label}-"))
        .tempdir()
        .expect("create the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Opens every record but the forged ones, whose signature does not verify.
struct Cipher(HashSet<String>);

impl RecordCipher for Cipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        if self.0.contains(&envelope.id) {
            return Err(EnvelopeError::SignatureInvalid);
        }
        Ok(
            json!({"title": format!("Note {}", envelope.id), "modifiedAt": "2020-01-01T00:00:00.000Z",
                   "clock": {"device-a": 1}})
                .to_string()
                .into_bytes(),
        )
    }
}

/// `device-a`'s key, the one signer the account knows.
#[cfg(feature = "markdown")]
struct DeviceA;

#[cfg(feature = "markdown")]
#[async_trait::async_trait]
impl memry_core::sync::hardening::purged::SignerKeys for DeviceA {
    async fn signing_key(
        &self,
        _http: &HttpClient,
        device_id: &str,
    ) -> Result<Option<Vec<u8>>, memry_core::api::errors::ApiError> {
        Ok((device_id == "device-a").then(|| signer().0))
    }

    fn known_devices(&self) -> Option<HashSet<String>> {
        None
    }
}

/// `device-a`'s Ed25519 key pair.
#[cfg(feature = "markdown")]
fn signer() -> (Vec<u8>, Vec<u8>) {
    let (public, secret) =
        memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("a key pair");
    (public.to_vec(), secret.to_vec())
}

/// The purged marker of `key` at `cursor` (chapter 05 §5.12.3), attested by
/// `device-a` over its own claim unless `forged`. Deleted after the row was
/// stored, so no local-newer refusal applies.
#[cfg(feature = "markdown")]
fn marker(key: &str, cursor: i64, forged: bool) -> Json {
    let (item_type, id) = typed(key);
    let clock: memry_core::sync::clock::VectorClock = [("device-a".to_owned(), 2)].into();
    let deleted_at = 4_000_000_000_000i64;
    let claim = memry_core::protocol::delete_attestation::DeleteClaim {
        item_type,
        item_id: id,
        clock: &clock,
        deleted_at: if forged { deleted_at + 1 } else { deleted_at },
    };
    let attestation =
        memry_core::protocol::delete_attestation::sign(&claim, &signer().1).expect("signed");
    json!({"id": id, "type": item_type, "deletedAt": deleted_at, "clock": clock,
           "serverCursor": cursor, "signerDeviceId": "device-a",
           "deleteAttestation": attestation})
}

struct NoBodies;

impl CrdtCipher for NoBodies {
    fn open(&self, _update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

const BLOB: &str =
    r#"{"dataNonce":"AAAA","encryptedData":"AAAA","encryptedKey":"AAAA","keyNonce":"AAAA"}"#;

fn live_meta() -> Json {
    json!({"operation": "update", "cryptoVersion": 1, "signature": "AAAA",
           "signerDeviceId": "device-a", "clock": {"device-a": 1}})
}

fn tombstone_meta() -> Json {
    json!({"operation": "delete", "cryptoVersion": 1, "signature": "AAAA",
           "signerDeviceId": "device-a", "deletedAt": 1_700_000_000_000i64,
           "clock": {"device-a": 2}})
}

/// `type:id` names its type; a bare id is a note.
fn typed(key: &str) -> (&str, &str) {
    key.split_once(':').unwrap_or(("note", key))
}

/// The `POST /sync/pull` item for `key`.
fn pull_item(key: &str) -> Json {
    let (item_type, id) = typed(key);
    let mut item = live_meta();
    item["id"] = json!(id);
    item["type"] = json!(item_type);
    item["blob"] = serde_json::from_str(BLOB).unwrap();
    item
}

#[derive(Clone)]
struct Entry {
    id: String,
    cursor: i64,
    meta: Option<Json>,
}

impl Entry {
    fn live(id: &str, cursor: i64) -> Self {
        Self {
            id: id.to_owned(),
            cursor,
            meta: Some(live_meta()),
        }
    }
}

/// A chapter 08 `record` pack: kind 0, `type:id` ([`typed`]), `sortKey` = cursor.
fn record_pack(entries: &[Entry]) -> Vec<u8> {
    let text = |out: &mut Vec<u8>, value: &str| {
        out.extend((value.len() as u16).to_be_bytes());
        out.extend(value.as_bytes());
    };
    let mut payload = Vec::new();
    let mut index = Vec::new();
    for entry in entries {
        let bytes = BLOB.as_bytes();
        index.push(0u8);
        let (item_type, id) = typed(&entry.id);
        text(&mut index, &format!("{item_type}:{id}"));
        text(&mut index, &format!("u/{item_type}/{id}"));
        index.extend((entry.cursor as u64).to_be_bytes());
        text(
            &mut index,
            &entry.meta.as_ref().map(Json::to_string).unwrap_or_default(),
        );
        index.extend((payload.len() as u64).to_be_bytes());
        index.extend((bytes.len() as u64).to_be_bytes());
        index.extend(Sha256::digest(bytes));
        payload.extend(bytes);
    }
    let mut out = b"MPAK".to_vec();
    out.extend([1u8, 0, 0, 0]);
    out.extend(&payload);
    let index_offset = out.len() as u64;
    out.extend(&index);
    out.extend(Sha256::digest(&payload));
    out.extend((entries.len() as u64).to_be_bytes());
    out.extend(index_offset.to_be_bytes());
    out.extend(b"MPAK");
    out.push(1);
    out
}

struct Pack {
    id: String,
    entries: Vec<Entry>,
    cover: Option<(i64, i64)>,
}

/// What the server holds. Every route answers from it.
#[derive(Default)]
struct Server {
    packs: Vec<Pack>,
    /// `(packedThrough, coveredThrough)` for `record`.
    coverage: Option<(i64, i64)>,
    /// Empty `crdt_snapshot` packs listed after the record packs.
    snapshots: usize,
    /// The live items: `type:id` ([`typed`]) and current `server_cursor`.
    live: Vec<(String, i64)>,
    /// Deleted ids the feed reports.
    deleted: Vec<String>,
    /// Ids `POST /sync/pull` answers with a signed delete.
    signed_deletes: Vec<String>,
    /// Purged markers `POST /sync/pull` serves for the ids it is asked, only
    /// to a request that declares `purged_tombstones`.
    markers: Vec<Json>,
    /// `POST /sync/pull` answers a body that is not a pull envelope.
    pull_not_envelope: bool,
    /// The manifest carries `serverCursor` (step 04 on).
    manifest_cursors: bool,
    /// Pack ids answered 404, and pack ids whose bytes are corrupt.
    missing: HashSet<String>,
    corrupt: HashSet<String>,
    /// A URL substring whose request never answers: the process is killed
    /// while it waits.
    hang: Option<String>,
}

impl Server {
    /// One `GET /sync/packs` page of 50 from `offset`, records then snapshots.
    fn listing(&self, offset: usize) -> Json {
        let snapshots = (0..self.snapshots).map(|at| {
            json!({"id": format!("s{at}"), "itemKind": "crdt_snapshot", "packKey": "k",
                   "minCursor": 1, "maxCursor": 1, "itemCount": 0, "byteSize": 10,
                   "createdAt": 1, "url": format!("https://r2.example/packs/s{at}"),
                   "expiresAt": 4_000_000_000i64})
        });
        let all: Vec<Json> = self
            .packs
            .iter()
            .map(|pack| {
                let mut listed = json!({"id": pack.id, "itemKind": "record", "packKey": "k",
                    "minCursor": pack.entries.first().map_or(0, |e| e.cursor),
                    "maxCursor": pack.entries.last().map_or(0, |e| e.cursor),
                    "itemCount": pack.entries.len(), "byteSize": 10, "createdAt": 1,
                    "url": format!("https://r2.example/packs/{}", pack.id),
                    "expiresAt": 4_000_000_000i64});
                if let Some((from, through)) = pack.cover {
                    listed["coverFrom"] = json!(from);
                    listed["coverThrough"] = json!(through);
                }
                listed
            })
            .chain(snapshots)
            .collect();
        let packs: Vec<&Json> = all.iter().skip(offset).take(50).collect();
        let mut body = json!({"packs": packs, "serverTime": 1});
        if offset + 50 < all.len() {
            body["nextCursor"] = json!((offset + 50).to_string());
        }
        if let Some((packed, covered)) = self.coverage.filter(|_| offset == 0) {
            body["coverage"] = json!([{"itemKind": "record", "packedThrough": packed,
                                       "coveredThrough": covered}]);
        }
        body
    }

    fn answer(&self, request: &HttpRequest) -> Option<Result<HttpResponse, TransportError>> {
        if self
            .hang
            .as_ref()
            .is_some_and(|hang| request.url.contains(hang))
        {
            return None;
        }
        let url = request.url.as_str();
        if let Some(id) = url.strip_prefix("https://r2.example/packs/") {
            if self.missing.contains(id) {
                return Some(response(404, "{}"));
            }
            if id.starts_with('s') {
                return Some(bytes_response(record_pack(&[])));
            }
            let pack = self.packs.iter().find(|pack| pack.id == id)?;
            let mut bytes = record_pack(&pack.entries);
            if self.corrupt.contains(id) {
                bytes[9] ^= 0xFF;
            }
            return Some(bytes_response(bytes));
        }
        if url.contains("/sync/packs") {
            let offset = url
                .split("cursor=")
                .nth(1)
                .map_or(0, |offset| offset.parse().unwrap());
            return Some(response(200, &self.listing(offset).to_string()));
        }
        if url.contains("/sync/changes") {
            let from: i64 = url
                .split("cursor=")
                .nth(1)
                .and_then(|rest| rest.split('&').next())
                .and_then(|cursor| cursor.parse().ok())
                .unwrap_or(0);
            let items: Vec<Json> = self
                .live
                .iter()
                .filter(|(_, cursor)| *cursor > from)
                .map(|(key, _)| {
                    let (item_type, id) = typed(key);
                    json!({"id": id, "type": item_type, "version": 1, "modifiedAt": 1, "size": 1})
                })
                .collect();
            let head = self
                .live
                .iter()
                .map(|(_, c)| *c)
                .max()
                .unwrap_or(0)
                .max(from);
            let deleted = if from == 0 {
                self.deleted.clone()
            } else {
                Vec::new()
            };
            return Some(response(
                200,
                &json!({"items": items, "deleted": deleted, "hasMore": false, "nextCursor": head})
                    .to_string(),
            ));
        }
        if url.contains("/sync/manifest") {
            let items: Vec<Json> = self
                .live
                .iter()
                .map(|(key, cursor)| {
                    let (item_type, id) = typed(key);
                    let mut item = json!({"id": id, "type": item_type, "version": 1,
                                          "modifiedAt": cursor, "size": 1});
                    if self.manifest_cursors {
                        item["serverCursor"] = json!(cursor);
                    }
                    item
                })
                .collect();
            return Some(response(
                200,
                &json!({"items": items, "serverTime": 1}).to_string(),
            ));
        }
        if url.contains("/sync/pull") {
            if self.pull_not_envelope {
                return Some(response(200, r#"{"error": "not an envelope"}"#));
            }
            let asked = body_json(request);
            let asked: Vec<&str> = asked["itemIds"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Json::as_str)
                .collect();
            let mut items: Vec<Json> = asked
                .iter()
                .flat_map(|id| {
                    self.live
                        .iter()
                        .filter(move |(live, _)| typed(live).1 == *id)
                        .map(|(live, _)| pull_item(live))
                })
                .collect();
            for key in &self.signed_deletes {
                if asked.contains(&typed(key).1) {
                    let mut item = pull_item(key);
                    item["operation"] = json!("delete");
                    item["deletedAt"] = json!(4_000_000_000_000i64);
                    item["clock"] = json!({"device-a": 2});
                    items.push(item);
                }
            }
            let declared = request
                .headers
                .get("x-memry-sync-types")
                .is_some_and(|types| types.split(',').any(|t| t == "purged_tombstones"));
            let markers: Vec<&Json> = self
                .markers
                .iter()
                .filter(|m| declared && asked.contains(&m["id"].as_str().unwrap()))
                .collect();
            return Some(response(
                200,
                &json!({"items": items, "purgedTombstones": markers}).to_string(),
            ));
        }
        panic!("unrouted request to {url}")
    }
}

struct Routes {
    server: Mutex<Server>,
    calls: Mutex<Vec<String>>,
    hung: Notify,
    /// Runs once, when the first `/sync/pull` is sent.
    on_pull: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Routes {
    fn new(server: Server) -> Arc<Self> {
        Arc::new(Self {
            server: Mutex::new(server),
            calls: Mutex::new(Vec::new()),
            hung: Notify::new(),
            on_pull: Mutex::new(None),
        })
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn count(&self, needle: &str) -> usize {
        self.calls()
            .iter()
            .filter(|url| url.contains(needle))
            .count()
    }
}

#[async_trait::async_trait]
impl Transport for Routes {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        self.calls.lock().unwrap().push(request.url.clone());
        if request.url.contains("/sync/pull") {
            let hook = self.on_pull.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let answer = self.server.lock().unwrap().answer(&request);
        match answer {
            Some(answer) => answer,
            None => {
                self.hung.notify_one();
                std::future::pending().await
            }
        }
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets".to_owned(),
        })
    }
}

fn first_sync(db: &Db, routes: &Arc<Routes>, forged: &[&str]) -> FirstSync {
    first_sync_declaring(db, routes, forged, false)
}

/// [`first_sync`], with the desktop's record pull when `desktop`.
fn first_sync_declaring(
    db: &Db,
    routes: &Arc<Routes>,
    forged: &[&str],
    desktop: bool,
) -> FirstSync {
    let http = Arc::new(HttpClient::new(
        Arc::clone(routes) as Arc<dyn Transport>,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    let cipher = Arc::new(Cipher(forged.iter().map(|id| (*id).to_owned()).collect()));
    let pull = if desktop {
        desktop_pull(Arc::clone(&http), db.clone(), cipher)
    } else {
        PullLoop::new(
            Arc::clone(&http),
            db.clone(),
            Declaration::subscribed(),
            cipher,
        )
    };
    let pull = Arc::new(pull);
    let bodies = Arc::new(BodyPull::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NoBodies),
    ));
    let packs = Arc::new(PackBootstrap::new(http, db.clone(), Arc::clone(&bodies)));
    FirstSync::new(pull, bodies, db.clone()).with_packs(packs)
}

async fn run(db: &Db, routes: &Arc<Routes>, forged: &[&str]) -> FirstSyncReport {
    first_sync(db, routes, forged)
        .run(1_800_000_000_000)
        .await
        .expect("the first sync finishes")
}

/// The desktop's record pull: it declares `purged_tombstones` and verifies
/// markers under [`DeviceA`].
#[cfg(feature = "markdown")]
fn desktop_pull(http: Arc<HttpClient>, db: Db, cipher: Arc<Cipher>) -> PullLoop {
    PullLoop::new(http, db, Declaration::desktop(), cipher).with_signer_keys(Arc::new(DeviceA))
}

#[cfg(not(feature = "markdown"))]
fn desktop_pull(_http: Arc<HttpClient>, _db: Db, _cipher: Arc<Cipher>) -> PullLoop {
    unreachable!("the desktop declaration needs the markdown feature")
}

/// Every note row: id, live, held cursor.
fn notes(db: &Db) -> HashMap<String, (bool, Option<i64>)> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT item_id, deleted_at IS NULL AND payload_state <> 'metadata-only',
                        server_cursor FROM sync_items WHERE item_type = 'note'",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))
            .unwrap()
            .collect::<Result<HashMap<_, _>, _>>()
            .unwrap();
        Ok(rows)
    })
    .unwrap()
}

fn live_ids(db: &Db) -> Vec<String> {
    let mut ids: Vec<String> = notes(db)
        .into_iter()
        .filter(|(_, (live, _))| *live)
        .map(|(id, _)| id)
        .collect();
    ids.sort();
    ids
}

/// `count` notes `n0..`, at cursors `1..=count`, split into packs of `per`,
/// with coverage that tiles to the last one.
fn covered_vault(count: i64, per: usize) -> Server {
    let entries: Vec<Entry> = (1..=count)
        .map(|cursor| Entry::live(&format!("n{cursor}"), cursor))
        .collect();
    let packs = entries
        .chunks(per)
        .enumerate()
        .map(|(at, chunk)| Pack {
            id: format!("p{at}"),
            cover: Some((chunk[0].cursor - 1, chunk.last().unwrap().cursor)),
            entries: chunk.to_vec(),
        })
        .collect();
    Server {
        packs,
        coverage: Some((count, count)),
        live: entries.iter().map(|e| (e.id.clone(), e.cursor)).collect(),
        manifest_cursors: true,
        ..Server::default()
    }
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

/// The request ceiling of a covered, unchanged vault of `N` records with `P`
/// listed packs of every kind, `R` of them record packs: one listing walk of
/// `ceil(P / 50)` pages (it pages every kind), `R` downloads, one feed page
/// from the coverage boundary and one manifest. Nothing in it counts items.
/// No spill directory is set, so the body pack phase lists nothing
/// (`sync_body_packs.rs` counts the walk it adds).
fn ceiling(packs: usize, record_packs: usize) -> usize {
    packs.div_ceil(50) + record_packs + 2
}

#[tokio::test]
async fn the_request_count_follows_the_packs_and_not_the_items() {
    for count in [40i64, 4_000] {
        let db = scratch_db("ceiling");
        let routes = Routes::new(covered_vault(count, 4_000));
        let report = run(&db, &routes, &[]).await;
        assert_eq!(
            routes.calls().len(),
            ceiling(1, 1),
            "N = {count}: {:?}",
            routes.calls()
        );
        assert_eq!(report.record_packs.entries_applied, count as usize);
        assert_eq!(report.reconcile_pulled, 0);
        assert_eq!(live_ids(&db).len(), count as usize);
        // The tail starts at the coverage boundary, not at 0.
        assert!(
            routes
                .calls()
                .iter()
                .any(|url| url.contains(&format!("cursor={count}")))
        );
    }
    let db = scratch_db("ceiling-three");
    let routes = Routes::new(covered_vault(300, 100));
    run(&db, &routes, &[]).await;
    assert_eq!(routes.calls().len(), ceiling(3, 3));

    // Snapshot packs share the listing, so 3 record and 60 snapshot packs
    // are two pages, and no snapshot pack is downloaded.
    let db = scratch_db("ceiling-paged");
    let mut server = covered_vault(300, 100);
    server.snapshots = 60;
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;
    assert_eq!(routes.count("/sync/packs"), 2, "{:?}", routes.calls());
    assert_eq!(routes.calls().len(), ceiling(63, 3));
    assert_eq!(report.record_packs.entries_applied, 300);
}

#[tokio::test]
async fn an_undeclared_last_entry_does_not_drop_the_chunk_before_it() {
    let db = scratch_db("undeclared-last");
    let mut server = covered_vault(3, 10);
    server.packs[0]
        .entries
        .push(Entry::live("agent_message:m1", 4));
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;
    assert_eq!(report.record_packs.entries_applied, 3);
    assert_eq!(routes.count("/sync/pull"), 0, "{:?}", routes.calls());
    assert_eq!(live_ids(&db).len(), 3);
}

#[tokio::test]
async fn a_row_edited_locally_during_the_reconcile_is_not_tombstoned() {
    let db = scratch_db("edited-in-flight");
    let mut server = covered_vault(4, 10);
    // n3 was deleted and its tombstone shed: the manifest omits it and the
    // pull by id answers nothing.
    server.live.retain(|(id, _)| id != "n3");
    let routes = Routes::new(server);
    let edit = db.clone();
    *routes.on_pull.lock().unwrap() = Some(Box::new(move || {
        edit.call_blocking(|conn| {
            conn.execute(
                "INSERT INTO outbox (item_type, item_id, op, enqueued_at)
                 VALUES ('note', 'n3', 'upsert', 1)",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    }));
    let report = run(&db, &routes, &[]).await;
    assert_eq!(routes.count("/sync/pull"), 1);
    assert_eq!(report.reconcile_removed, 0);
    assert!(notes(&db)["n3"].0, "the local edit keeps n3 live");
}

#[tokio::test]
async fn a_shed_row_sharing_an_id_with_another_types_pulled_item_is_removed() {
    let db = scratch_db("shared-id");
    let mut server = covered_vault(2, 10);
    // note:x1 was deleted; task:x1, never packed, is live. The pull of the
    // listed task:x1 already answers note:x1's signed delete by id.
    server.packs[0].entries.push(Entry::live("x1", 3));
    server.live.push(("task:x1".into(), 9));
    server.signed_deletes.push("x1".into());
    let routes = Routes::new(server);
    run(&db, &routes, &[]).await;
    assert!(!notes(&db)["x1"].0, "note:x1 is not listed");
}

#[tokio::test]
async fn the_manifest_pulls_what_the_packs_did_not_hold_at_its_cursor_and_drops_the_rest() {
    let db = scratch_db("reconcile");
    let mut server = covered_vault(4, 10);
    // n2 was rewritten after its pack (cursor 9), n5 was never packed, and
    // n3 was deleted, so the manifest omits it and pull answers its signed
    // delete. n4's tombstone is packed.
    server.live = vec![("n1".into(), 1), ("n2".into(), 9), ("n5".into(), 8)];
    server.signed_deletes.push("n3".into());
    server.packs[0].entries[3].meta = Some(tombstone_meta());
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;

    assert_eq!(
        live_ids(&db),
        sorted(vec!["n1".into(), "n2".into(), "n5".into()])
    );
    let rows = notes(&db);
    assert_eq!(rows["n1"], (true, Some(1)), "held at the manifest's cursor");
    assert_eq!(rows["n2"].1, None, "pulled by id: no known cursor");
    assert!(!rows["n3"].0 && !rows["n4"].0);
    assert_eq!(report.reconcile_removed, 1);
}

/// `covered_vault(4, 10)` whose manifest omits n3, set up by `stage`, synced
/// by the desktop's record pull when `desktop`.
async fn omitted_n3(
    label: &str,
    desktop: bool,
    stage: impl FnOnce(&mut Server),
) -> (Db, FirstSyncReport) {
    let db = scratch_db(label);
    let mut server = covered_vault(4, 10);
    server.live.retain(|(id, _)| id != "n3");
    stage(&mut server);
    let routes = Routes::new(server);
    let report = first_sync_declaring(&db, &routes, &[], desktop)
        .run(1_800_000_000_000)
        .await
        .expect("the first sync finishes");
    assert_eq!(routes.count("/sync/pull"), 1, "{:?}", routes.calls());
    (db, report)
}

/// §5.12.1 (#5402): an omission is no evidence of a delete. A held row the
/// manifest leaves out and the pull answers nothing for stays live.
#[tokio::test]
async fn an_omitted_row_the_pull_leaves_unanswered_is_kept() {
    let (db, report) = omitted_n3("omitted-unanswered", false, |_| {}).await;
    assert!(notes(&db)["n3"].0, "no signed evidence: n3 stays live");
    assert_eq!(report.reconcile_removed, 0);
}

/// §5.14: a pull answer that is not an envelope deletes nothing.
#[tokio::test]
async fn an_omitted_row_whose_pull_is_not_an_envelope_is_kept() {
    let (db, report) = omitted_n3("omitted-not-envelope", false, |server| {
        server.pull_not_envelope = true;
    })
    .await;
    assert!(notes(&db)["n3"].0);
    assert_eq!(report.reconcile_removed, 0);
}

/// A tombstone the server still holds arrives signed and deletes.
#[tokio::test]
async fn an_omitted_row_the_pull_answers_with_a_signed_delete_is_removed() {
    let (db, report) = omitted_n3("omitted-signed", false, |server| {
        server.signed_deletes.push("n3".into());
    })
    .await;
    assert!(!notes(&db)["n3"].0, "the signed delete removes n3");
    assert_eq!(report.reconcile_removed, 1);
}

/// §5.12.3: a shed tombstone converges through its attested marker, which
/// the pull is served only because it declares `purged_tombstones`.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn an_omitted_row_the_pull_answers_with_an_attested_marker_is_removed() {
    let (db, report) = omitted_n3("omitted-marker", true, |server| {
        server.markers.push(marker("n3", 7, false));
    })
    .await;
    assert!(!notes(&db)["n3"].0, "the attested marker removes n3");
    assert_eq!(report.reconcile_removed, 1);
}

/// A marker whose attestation does not verify deletes nothing.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn an_omitted_row_with_a_forged_marker_is_kept() {
    let (db, report) = omitted_n3("omitted-forged", true, |server| {
        server.markers.push(marker("n3", 7, true));
    })
    .await;
    assert!(notes(&db)["n3"].0);
    assert_eq!(report.reconcile_removed, 0);
}

#[tokio::test]
async fn packs_without_coverage_tail_from_zero_and_still_save_every_pull() {
    // Every server before step 07 lists record packs with no coverage, so the
    // refs pass reads the feed from 0 over rows the packs already hold. The
    // refs name items, not writes, and must leave the held cursors alone.
    let db = scratch_db("uncovered");
    let mut server = covered_vault(50, 100);
    server.coverage = None;
    server.packs[0].cover = None;
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;
    assert_eq!(report.record_packs.tail_start, 0);
    assert_eq!(report.reconcile_pulled, 0);
    assert_eq!(routes.count("/sync/pull"), 0);
    assert_eq!(live_ids(&db).len(), 50);
}

#[tokio::test]
async fn a_manifest_without_server_cursors_pulls_every_item() {
    let db = scratch_db("untrusted");
    let mut server = covered_vault(30, 100);
    server.manifest_cursors = false;
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;
    assert_eq!(report.reconcile_pulled, 30);
    assert_eq!(live_ids(&db).len(), 30);
}

#[tokio::test]
async fn a_record_pack_without_meta_leaves_its_items_to_the_tail_and_the_manifest() {
    let db = scratch_db("no-meta");
    let mut server = covered_vault(6, 3);
    for entry in &mut server.packs[1].entries {
        entry.meta = None;
    }
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;
    assert_eq!(report.record_packs.entries_unusable, 3);
    // The tail starts below the first unusable entry (cursor 4).
    assert_eq!(report.record_packs.tail_start, 3);
    assert!(routes.calls().iter().any(|url| url.contains("cursor=3")));
    assert_eq!(live_ids(&db).len(), 6);
    assert_eq!(notes(&db)["n5"].1, None, "pulled, not taken from the pack");
}

#[tokio::test]
async fn an_entry_that_does_not_verify_is_pulled_and_not_recorded_corrupt() {
    let db = scratch_db("forged");
    let routes = Routes::new(covered_vault(5, 10));
    // The pull of n3 opens with the same cipher, so it stays unopenable and is
    // recorded corrupt by the pull, never applied from the pack.
    let report = run(&db, &routes, &["n3"]).await;
    assert_eq!(report.record_packs.entries_unusable, 1);
    assert_eq!(report.record_packs.tail_start, 2);
    assert!(!notes(&db)["n3"].0);
    assert_eq!(live_ids(&db).len(), 4);
}

#[tokio::test]
async fn a_corrupt_pack_and_a_pack_gone_between_listing_and_download_are_gaps() {
    for broken in ["corrupt", "missing"] {
        let db = scratch_db(broken);
        let mut server = covered_vault(9, 3);
        let set = if broken == "corrupt" {
            &mut server.corrupt
        } else {
            &mut server.missing
        };
        set.insert("p1".to_owned());
        let routes = Routes::new(server);
        let report = run(&db, &routes, &[]).await;
        assert_eq!(
            report.record_packs.tail_start, 3,
            "{broken}: the walk stops at the gap"
        );
        assert_eq!(
            routes.count("/packs/p1"),
            1,
            "{broken}: the URL is not retried"
        );
        assert_eq!(live_ids(&db).len(), 9, "{broken}");
        for id in ["n4", "n5", "n6"] {
            assert_eq!(notes(&db)[id].1, None, "{broken}: {id} came by id");
        }
    }
}

#[tokio::test]
async fn a_server_with_snapshot_packs_only_bootstraps_records_item_by_item() {
    let db = scratch_db("snapshot-only");
    let server = Server {
        live: (1..=5).map(|c| (format!("n{c}"), c)).collect(),
        ..Server::default()
    };
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;
    assert_eq!(report.record_packs.packs_applied, 0);
    assert_eq!(
        routes.count("/sync/manifest"),
        0,
        "no pack used, no reconcile"
    );
    assert_eq!(report.metadata_applied, 5);
    assert_eq!(live_ids(&db).len(), 5);
}

async fn killed_at(db: &Db, routes: &Arc<Routes>) {
    let running = first_sync(db, routes, &[]);
    tokio::select! {
        result = running.run(1_800_000_000_000) => {
            let outcome: Result<FirstSyncReport, FirstSyncError> = result;
            panic!("the run finished before the kill: {:?}", outcome.map(|_| ()));
        }
        () = routes.hung.notified() => {}
    }
}

#[tokio::test]
async fn a_kill_in_each_record_phase_resumes_without_downloading_a_finished_pack_again() {
    for phase in ["/packs/p3", "/sync/changes", "/sync/manifest", "/sync/pull"] {
        let db = scratch_db("kill");
        let mut server = covered_vault(12, 3);
        server.live[5].1 = 20; // n6 was rewritten: the reconcile pulls it.
        server.hang = Some(phase.to_owned());
        let routes = Routes::new(server);
        killed_at(&db, &routes).await;

        let finished: Vec<String> = db
            .call_blocking(|conn| read_meta(conn, META_RECORD_PACKS_DONE))
            .unwrap()
            .map(|text| serde_json::from_str::<Vec<Json>>(&text).unwrap())
            .unwrap_or_default()
            .iter()
            .map(|pack| pack["id"].as_str().unwrap().to_owned())
            .collect();
        routes.server.lock().unwrap().hang = None;
        run(&db, &routes, &[]).await;

        for id in &finished {
            assert_eq!(
                routes.count(&format!("/packs/{id}")),
                1,
                "{phase}: {id} again"
            );
        }
        assert_eq!(live_ids(&db).len(), 12, "{phase}");
        assert_eq!(
            notes(&db)["n6"].1,
            None,
            "{phase}: n6 pulled at its new write"
        );
    }
}

//! A fresh device takes its records from `record` packs, tails the feed from
//! where the packs end, and closes with the cursor-exact manifest reconcile
//! (chapter 08 §8.4.2, §8.10, #5232).
//!
//! Real `HttpClient`, SQLite, pack reader, decode and apply. The fake is the
//! `Transport`, answering by route so parallel pack downloads need no script
//! order, and the record cipher, which answers a payload per id.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::http_fakes::{body_json, bytes_response, response, response_with_header};
use memry_core::api::errors::TransportError;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{
    ClientIdentity, DEFAULT_REQUEST_TIMEOUT_MS, HttpClient, IDLE_TIMEOUT_MS,
};
use memry_core::protocol::types::Declaration;
use memry_core::seams::diagnostics::{CoreDiagnostic, DiagnosticPhase, DiagnosticsSink};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::diagnostics::RunDiagnostics;
use memry_core::sync::first_sync::{
    FirstSync, FirstSyncError, FirstSyncReport, META_FIRST_SYNC_RECONCILED,
};
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::pack_bootstrap::{
    META_RECORD_PACKS_DONE, PACK_RETRY_PAUSES, PackBootstrap, pack_deadline_ms,
};
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

    fn signing_key(&self, device_id: &str) -> Option<Vec<u8>> {
        (device_id == "device-a").then(|| signer().0)
    }
}

/// `device-a`'s Ed25519 key pair.
fn signer() -> (Vec<u8>, Vec<u8>) {
    let (public, secret) =
        memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("a key pair");
    (public, secret.to_vec())
}

/// The purged marker of `key` at `cursor` (chapter 05 §5.12.3), attested by
/// `device-a` over its own claim unless `forged`, in the vault the run syncs.
/// Deleted in 2023, before this device seeded the row from its pack: the seed
/// is no local change.
fn marker(key: &str, cursor: i64, forged: bool) -> Json {
    marker_in(VAULT, key, cursor, forged)
}

/// The vault every run here syncs (`X-Memry-Vault-Id`).
const VAULT: &str = "vault-a";

/// [`marker`], attested in `vault_id` (`None`: v1, before #5247).
fn marker_in(
    vault_id: impl Into<Option<&'static str>>,
    key: &str,
    cursor: i64,
    forged: bool,
) -> Json {
    let (item_type, id) = typed(key);
    let clock: memry_core::sync::clock::VectorClock = [("device-a".to_owned(), 2)].into();
    let deleted_at = 1_700_000_000_000i64;
    let claim = memry_core::protocol::delete_attestation::DeleteClaim {
        item_type,
        item_id: id,
        clock: &clock,
        deleted_at: if forged { deleted_at + 1 } else { deleted_at },
    };
    let attestation =
        memry_core::protocol::delete_attestation::sign(&claim, vault_id.into(), &signer().1)
            .expect("signed");
    json!({"id": id, "type": item_type, "deletedAt": deleted_at, "clock": clock,
           "serverCursor": cursor, "signerDeviceId": "device-a",
           "deleteAttestation": attestation})
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
    /// Deleted ids the feed reports, with the cursor of the delete.
    deleted: Vec<(String, i64)>,
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
    /// `byteSize` of every listed record pack; 10 when unset.
    byte_size: Option<u64>,
    /// Every record pack GET times out on this timer.
    pack_timeout: Option<Timer>,
    /// Record pack GETs answer offline until this instant of the paused
    /// test clock: the network dropped.
    offline_until: Option<tokio::time::Instant>,
    /// What a dropped request answers; offline when unset.
    dropped_as: Option<Dropped>,
    /// Every `GET /sync/packs` after the first is dropped too.
    relists_dropped: bool,
    listings: AtomicUsize,
    /// Presigned URLs live this long on the test clock, and a GET on an
    /// expired one answers 403. Unset, every URL lives past the run.
    presign: Option<Presign>,
    /// Once re-listed, every record pack GET answers 403, live URL or not.
    resigned_refused: bool,
}

/// What the network answers while it is down.
#[derive(Clone, Copy)]
enum Dropped {
    Status(u16),
    /// A 429 with `Retry-After` in seconds.
    RateLimited(u64),
}

impl Server {
    fn dropped(&self) -> Option<Result<HttpResponse, TransportError>> {
        if !self
            .offline_until
            .is_some_and(|until| tokio::time::Instant::now() < until)
        {
            return None;
        }
        Some(match self.dropped_as {
            None => Err(TransportError::Offline),
            Some(Dropped::Status(status)) => response(status, "{}"),
            Some(Dropped::RateLimited(after_s)) => {
                response_with_header(429, "{}", ("retry-after", &after_s.to_string()))
            }
        })
    }
}

/// Signs the record pack URLs on the paused test clock: `wall_s` at `at`.
struct Presign {
    wall_s: i64,
    at: tokio::time::Instant,
    life_s: i64,
}

impl Presign {
    fn now(&self) -> i64 {
        self.wall_s + self.at.elapsed().as_secs() as i64
    }
}

/// Which timer ended a pack GET (chapter 00 §0.6).
#[derive(Clone, Copy)]
enum Timer {
    /// The request's own deadline: `elapsed_ms` is its `timeout_ms`.
    Deadline,
    /// The idle limit, which fires before a pack's deadline.
    Idle,
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
                let expires_at = self
                    .presign
                    .as_ref()
                    .map_or(4_000_000_000i64, |presign| presign.now() + presign.life_s);
                let mut listed = json!({"id": pack.id, "itemKind": "record", "packKey": "k",
                    "minCursor": pack.entries.first().map_or(0, |e| e.cursor),
                    "maxCursor": pack.entries.last().map_or(0, |e| e.cursor),
                    "itemCount": pack.entries.len(), "byteSize": self.byte_size.unwrap_or(10), "createdAt": 1,
                    "url": format!("https://r2.example/packs/{}?exp={expires_at}", pack.id),
                    "expiresAt": expires_at});
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
        if let Some(rest) = url.strip_prefix("https://r2.example/packs/") {
            let (id, expires_at) = rest.split_once("?exp=").unwrap_or((rest, ""));
            if let Some(dropped) = self.dropped() {
                return Some(dropped);
            }
            if let Some(presign) = &self.presign
                && expires_at
                    .parse::<i64>()
                    .is_ok_and(|expires_at| expires_at <= presign.now())
            {
                return Some(response(403, "{}"));
            }
            if self.resigned_refused && self.listings.load(Ordering::Relaxed) > 1 {
                return Some(response(403, "{}"));
            }
            if let Some(timer) = self.pack_timeout {
                let elapsed_ms = match timer {
                    Timer::Deadline => request.timeout_ms,
                    Timer::Idle => IDLE_TIMEOUT_MS,
                };
                return Some(Err(TransportError::Timeout { elapsed_ms }));
            }
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
            let relist = self.listings.fetch_add(1, Ordering::Relaxed) > 0;
            if relist
                && self.relists_dropped
                && let Some(dropped) = self.dropped()
            {
                return Some(dropped);
            }
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
                .chain(&self.deleted)
                .map(|(_, c)| *c)
                .max()
                .unwrap_or(0)
                .max(from);
            let deleted: Vec<&str> = self
                .deleted
                .iter()
                .filter(|(_, cursor)| *cursor > from)
                .map(|(id, _)| id.as_str())
                .collect();
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
    /// Each request's url and the `timeout_ms` it reached the seam with.
    timeouts: Mutex<Vec<(String, u64)>>,
    hung: Notify,
    /// Runs once, when the first `/sync/pull` is sent.
    on_pull: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Runs once, when `/sync/manifest` is sent.
    on_manifest: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Routes {
    fn new(server: Server) -> Arc<Self> {
        Arc::new(Self {
            server: Mutex::new(server),
            calls: Mutex::new(Vec::new()),
            timeouts: Mutex::new(Vec::new()),
            hung: Notify::new(),
            on_pull: Mutex::new(None),
            on_manifest: Mutex::new(None),
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
        self.timeouts
            .lock()
            .unwrap()
            .push((request.url.clone(), request.timeout_ms));
        let hook = if request.url.contains("/sync/pull") {
            self.on_pull.lock().unwrap().take()
        } else if request.url.contains("/sync/manifest") {
            self.on_manifest.lock().unwrap().take()
        } else {
            None
        };
        if let Some(hook) = hook {
            hook();
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
    first_sync_with(
        db,
        routes,
        forged,
        false,
        &RunDiagnostics::silent(),
        Some(VAULT),
    )
}

/// [`first_sync`], with the desktop's record pull when `desktop`.
fn first_sync_declaring(
    db: &Db,
    routes: &Arc<Routes>,
    forged: &[&str],
    desktop: bool,
) -> FirstSync {
    first_sync_with(
        db,
        routes,
        forged,
        desktop,
        &RunDiagnostics::silent(),
        Some(VAULT),
    )
}

/// [`first_sync`] whose pack downloads are counted by `diagnostics`, its pull
/// knowing `vault` as the vault it syncs.
fn first_sync_observed(
    db: &Db,
    routes: &Arc<Routes>,
    forged: &[&str],
    diagnostics: &Arc<RunDiagnostics>,
    vault: Option<&str>,
) -> FirstSync {
    first_sync_with(db, routes, forged, false, diagnostics, vault)
}

/// [`first_sync`] with the desktop's record pull when `desktop`, its pack
/// downloads counted by `diagnostics`, its pull knowing `vault` as the vault
/// it syncs.
fn first_sync_with(
    db: &Db,
    routes: &Arc<Routes>,
    forged: &[&str],
    desktop: bool,
    diagnostics: &Arc<RunDiagnostics>,
    vault: Option<&str>,
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
    let pull = Arc::new(match vault {
        Some(vault) => pull.with_vault(vault),
        None => pull,
    });
    let bodies = Arc::new(BodyPull::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NoBodies),
    ));
    let packs = Arc::new(PackBootstrap::new(
        diagnostics.observe(&http),
        db.clone(),
        Arc::clone(&bodies),
    ));
    FirstSync::new(pull, bodies, db.clone())
        .with_packs(packs)
        .with_diagnostics(Arc::clone(diagnostics))
}

async fn run(db: &Db, routes: &Arc<Routes>, forged: &[&str]) -> FirstSyncReport {
    first_sync(db, routes, forged)
        .run(1_800_000_000_000)
        .await
        .expect("the first sync finishes")
}

/// The desktop's record pull: it declares `purged_tombstones` and verifies
/// markers under [`DeviceA`]. Its cipher knows no signer, as the desktop's
/// directory cipher, so a marker's key comes from the directory lookup.
#[cfg(feature = "markdown")]
fn desktop_pull(http: Arc<HttpClient>, db: Db, cipher: Arc<Cipher>) -> PullLoop {
    PullLoop::new(
        http,
        db,
        Declaration::desktop(),
        Arc::new(DirectoryOnly(cipher)),
    )
    .with_signer_keys(Arc::new(DeviceA))
}

/// [`Cipher`] without its signer keys.
#[cfg(feature = "markdown")]
struct DirectoryOnly(Arc<Cipher>);

#[cfg(feature = "markdown")]
impl RecordCipher for DirectoryOnly {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        self.0.open(envelope)
    }
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

/// What the reconcile remembered for the push wave (#5406): id and clock,
/// from the `meta` rows keyed `sync.unattested_marker\0{type}\0{id}`.
fn remembered(db: &Db) -> Vec<(String, Option<String>)> {
    let rows: Vec<(String, String)> = db
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT key, value FROM meta WHERE key LIKE 'sync.unattested_marker%' ORDER BY key",
                )
                .unwrap();
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            Ok(rows)
        })
        .unwrap();
    rows.into_iter()
        .map(|(key, value)| {
            let id = key.rsplit('\0').next().unwrap().to_owned();
            let value: Json = serde_json::from_str(&value).unwrap();
            let clock = Some(&value["clock"])
                .filter(|c| !c.is_null())
                .map(Json::to_string);
            (id, clock)
        })
        .collect()
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

/// #5331: an 8 MiB pack at 0.5 Mbit/s takes about 134 s, past the 60 s
/// ceiling of every other request, so its GET gets a deadline scaled to the
/// listed `byteSize` (chapter 00 §0.6).
#[tokio::test]
async fn a_pack_get_gets_a_deadline_scaled_to_its_listed_size() {
    const EIGHT_MIB: u64 = 8 * 1024 * 1024;
    let db = scratch_db("deadline");
    let mut server = covered_vault(40, 40);
    server.byte_size = Some(EIGHT_MIB);
    let routes = Routes::new(server);
    run(&db, &routes, &[]).await;

    let timeouts = routes.timeouts.lock().unwrap().clone();
    let (packs, rest): (Vec<_>, Vec<_>) = timeouts
        .into_iter()
        .partition(|(url, _)| url.starts_with("https://r2.example/packs/"));
    let half_megabit_ms = EIGHT_MIB * 8 * 1000 / 500_000;
    assert_eq!(packs.len(), 1, "{packs:?}");
    assert_eq!(packs[0].1, pack_deadline_ms(Some(EIGHT_MIB)));
    assert!(packs[0].1 > half_megabit_ms, "{packs:?}");
    assert!(
        rest.iter()
            .all(|(_, timeout)| *timeout == DEFAULT_REQUEST_TIMEOUT_MS),
        "{rest:?}"
    );
}

/// #5331: a pack GET that ran out its deadline spent minutes on the line, so
/// it is not sent again from byte 0. One that went idle is retried: on the
/// transport ladder, then after each of the phase's pauses (#5374).
#[tokio::test(start_paused = true)]
async fn a_pack_get_past_its_deadline_is_not_retried_but_an_idle_one_is() {
    let idle_sends = 4 * (1 + PACK_RETRY_PAUSES as usize);
    for (timer, sends) in [(Timer::Deadline, 1), (Timer::Idle, idle_sends)] {
        let db = scratch_db("deadline-retry");
        let mut server = covered_vault(40, 40);
        server.byte_size = Some(8 * 1024 * 1024);
        server.pack_timeout = Some(timer);
        let routes = Routes::new(server);
        run(&db, &routes, &[]).await;

        let calls = routes.calls.lock().unwrap().clone();
        let packs = calls
            .iter()
            .filter(|url| url.starts_with("https://r2.example/packs/"))
            .count();
        assert_eq!(packs, sends, "{calls:?}");
        assert_eq!(
            live_ids(&db).len(),
            40,
            "the records land after {sends} pack sends"
        );
    }
}

/// Seven record packs, whose GETs the network drops for `drop_s` seconds of
/// the paused clock from the start of the run, signed for `life_s` seconds.
fn dropped_vault(drop_s: u64, life_s: Option<i64>) -> Arc<Routes> {
    Routes::new(dropped_server(drop_s, life_s))
}

fn dropped_server(drop_s: u64, life_s: Option<i64>) -> Server {
    let mut server = covered_vault(70, 10);
    server.offline_until =
        Some(tokio::time::Instant::now() + std::time::Duration::from_secs(drop_s));
    server.presign = life_s.map(|life_s| Presign {
        wall_s: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64,
        at: tokio::time::Instant::now(),
        life_s,
    });
    server
}

fn pack_gets(routes: &Routes) -> usize {
    routes.count("https://r2.example/packs/")
}

/// #5374: a 30 s drop at the first pack GETs used to end all seven packs
/// inside the transport ladder's 14 s, leaving every record to the manifest.
#[tokio::test(start_paused = true)]
async fn a_pack_lost_to_a_network_drop_downloads_once_the_network_returns() {
    let db = scratch_db("drop");
    let routes = dropped_vault(30, None);
    let report = run(&db, &routes, &[]).await;

    assert_eq!(report.record_packs.packs_applied, 7, "{report:?}");
    assert!(
        report.record_packs.fallback_reasons.is_empty(),
        "{report:?}"
    );
    assert_eq!(report.record_packs.tail_start, 70);
    assert_eq!(report.reconcile_pulled, 0);
    assert_eq!(routes.count("/sync/pull"), 0, "{:?}", routes.calls());
    assert_eq!(live_ids(&db).len(), 70);
}

/// A drop that outlives the 300 s presigned URLs: the retry re-lists for
/// fresh URLs instead of sending the expired ones (§8.12).
#[tokio::test(start_paused = true)]
async fn a_retry_past_the_url_lifetime_re_lists_before_it_downloads() {
    let db = scratch_db("drop-relist");
    let routes = dropped_vault(300, Some(300));
    let report = run(&db, &routes, &[]).await;

    assert_eq!(report.record_packs.packs_applied, 7, "{report:?}");
    assert_eq!(report.reconcile_pulled, 0);
    assert_eq!(routes.count("/sync/packs"), 2, "{:?}", routes.calls());
    assert_eq!(live_ids(&db).len(), 70);
}

/// #5247: a re-signed pack keeps the expiry the re-list gave it, so a 403 on
/// its URL while that URL is live is final. The pack becomes a gap at once,
/// and the phase neither pauses for it nor re-lists again.
#[tokio::test(start_paused = true)]
async fn a_403_on_a_live_re_signed_url_is_final() {
    let db = scratch_db("drop-relist-refused");
    // The URLs expire during the first pause, so the re-list comes with
    // pauses still left to take.
    let mut server = dropped_server(30, Some(60));
    server.resigned_refused = true;
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;

    assert_eq!(report.record_packs.packs_applied, 0, "{report:?}");
    assert_eq!(report.record_packs.fallback_reasons.len(), 7, "{report:?}");
    let calls = routes.calls();
    let relist = calls
        .iter()
        .enumerate()
        .filter(|(_, url)| url.contains("/sync/packs"))
        .map(|(at, _)| at)
        .nth(1)
        .expect("the drop outlived the URLs, so the phase re-listed");
    let gets_after = calls[relist..]
        .iter()
        .filter(|url| url.contains("https://r2.example/packs/"))
        .count();
    assert_eq!(gets_after, 7, "one GET per re-signed pack: {calls:?}");
    assert_eq!(routes.count("/sync/packs"), 2, "{calls:?}");
    assert_eq!(live_ids(&db).len(), 70);
}

/// REVIEW-5383: the re-list a retry needs fails while the network is still
/// down. The packs wait for the next pause instead of becoming gaps.
#[tokio::test(start_paused = true)]
async fn a_re_list_lost_to_the_drop_keeps_its_packs_for_the_next_pause() {
    let db = scratch_db("drop-relist-offline");
    let mut server = dropped_server(200, Some(60));
    server.relists_dropped = true;
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;

    assert_eq!(report.record_packs.packs_applied, 7, "{report:?}");
    assert!(report.record_packs.used);
    assert_eq!(live_ids(&db).len(), 70);
}

/// A 504 is as curable as a 503, and a 429 pauses for at least its
/// `Retry-After`: a 95 s limit is waited out in one pause, not three.
#[tokio::test(start_paused = true)]
async fn a_504_and_a_429_pause_the_phase_and_the_429_waits_its_retry_after() {
    for (dropped, drop_s) in [(Dropped::Status(504), 30), (Dropped::RateLimited(100), 95)] {
        let db = scratch_db("drop-status");
        let mut server = dropped_server(drop_s, None);
        server.dropped_as = Some(dropped);
        let routes = Routes::new(server);
        let report = run(&db, &routes, &[]).await;

        assert_eq!(report.record_packs.packs_applied, 7, "{report:?}");
        assert_eq!(live_ids(&db).len(), 70);
        if let Dropped::RateLimited(_) = dropped {
            assert_eq!(pack_gets(&routes), 3 + 7, "{:?}", routes.calls());
        }
    }
}

/// #5215: the pause the phase takes after a 429 is a retry and a rate-limit
/// wait in its statistics, which the 504 pause is not.
#[tokio::test(start_paused = true)]
async fn the_pack_download_counts_its_429_pause_and_not_a_5xx_pause() {
    #[derive(Default)]
    struct Captured(Mutex<Vec<CoreDiagnostic>>);
    impl DiagnosticsSink for Captured {
        fn record(&self, event: CoreDiagnostic) {
            self.0.lock().unwrap().push(event);
        }
    }

    for (label, dropped) in [
        ("504", Dropped::Status(504)),
        ("429", Dropped::RateLimited(100)),
    ] {
        let db = scratch_db("drop-counted");
        let mut server = dropped_server(95, None);
        server.dropped_as = Some(dropped);
        let routes = Routes::new(server);
        let sink = Arc::new(Captured::default());
        let diagnostics = RunDiagnostics::new(sink.clone());
        first_sync_observed(&db, &routes, &[], &diagnostics, Some(VAULT))
            .run(1_800_000_000_000)
            .await
            .expect("the first sync finishes");

        let stats = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .find_map(|event| match event {
                CoreDiagnostic::PhaseStats {
                    phase: DiagnosticPhase::RecordPacks,
                    finished: true,
                    requests,
                    ..
                } => Some(*requests),
                _ => None,
            })
            .expect("the record packs phase reports");
        match dropped {
            Dropped::RateLimited(after_s) => {
                // Three GETs refused, one pause for all of them: a 429 is
                // not retried by the ladder, so the pause is the only retry.
                assert_eq!(stats.rate_limited, 3, "{label}");
                assert_eq!(stats.retries, 1, "{label}");
                assert_eq!(stats.rate_limit_wait_ms, after_s * 1_000, "{label}");
            }
            Dropped::Status(_) => {
                assert_eq!(stats.rate_limited, 0, "{label}");
                assert_eq!(stats.rate_limit_wait_ms, 0, "{label}");
            }
        }
    }
}

/// A network that never comes back costs bounded waiting, then every pack is
/// a gap and the manifest reconcile still brings every record.
#[tokio::test(start_paused = true)]
async fn a_drop_longer_than_every_pause_leaves_gaps_the_manifest_fills() {
    let db = scratch_db("drop-forever");
    let routes = dropped_vault(86_400, None);
    // Four pauses of 30, 60, 120 and 240 s, and the ladders between them, end
    // inside 20 minutes of the paused clock, whatever the runner's load.
    let report = tokio::time::timeout(
        std::time::Duration::from_secs(20 * 60),
        run(&db, &routes, &[]),
    )
    .await
    .expect("bounded waiting");

    assert_eq!(report.record_packs.packs_applied, 0, "{report:?}");
    assert_eq!(report.record_packs.fallback_reasons.len(), 7, "{report:?}");
    assert_eq!(report.record_packs.tail_start, 0);
    assert_eq!(live_ids(&db).len(), 70);
    assert!(pack_gets(&routes) < 100, "{}", pack_gets(&routes));
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

/// An upsert queued while the stale pull is in flight outranks the attested
/// marker that pull answers: the row is rechecked in the deleting transaction.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn a_row_edited_locally_during_the_reconcile_is_not_tombstoned() {
    let db = scratch_db("edited-in-flight");
    let mut server = covered_vault(4, 10);
    // n3 was deleted and its tombstone shed: the manifest omits it and the
    // pull by id answers its attested marker, which the edit outranks.
    server.live.retain(|(id, _)| id != "n3");
    server.markers.push(marker("n3", 7, false));
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
    let report = first_sync_declaring(&db, &routes, &[], true)
        .run(1_800_000_000_000)
        .await
        .expect("the first sync finishes");
    assert_eq!(routes.count("/sync/pull"), 1);
    assert_eq!(report.reconcile_removed, 0);
    assert!(notes(&db)["n3"].0, "the local edit keeps n3 live");
}

#[tokio::test]
async fn a_deleted_row_sharing_an_id_with_another_types_pulled_item_is_removed_by_its_signed_delete()
 {
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
async fn a_shed_row_sharing_an_id_with_another_types_pulled_item_is_removed() {
    let db = scratch_db("shared-id-shed");
    let mut server = covered_vault(2, 10);
    // note:x1 was deleted and shed; task:x1, never packed, is live.
    server.packs[0].entries.push(Entry::live("x1", 3));
    server.live.push(("task:x1".into(), 9));
    server.markers.push(marker("x1", 10, false));
    let routes = Routes::new(server);
    let report = run(&db, &routes, &[]).await;
    assert!(!notes(&db)["x1"].0, "note:x1 is not listed");
    assert_eq!(report.reconcile_removed, 1);
}

#[tokio::test]
async fn the_manifest_pulls_what_the_packs_did_not_hold_at_its_cursor_and_drops_the_rest() {
    let db = scratch_db("reconcile");
    let mut server = covered_vault(4, 10);
    // n2 was rewritten after its pack (cursor 9), n5 was never packed, and
    // n3's tombstone was shed, so the manifest omits it and pull answers its
    // attested marker. n4's tombstone is packed.
    server.live = vec![("n1".into(), 1), ("n2".into(), 9), ("n5".into(), 8)];
    server.markers.push(marker("n3", 10, false));
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

/// #5405: while the reconcile is due the refs pass sends no pull for a
/// `deleted` id. n3 was deleted after the packs (cursor 6), so the feed tail
/// lists it and the manifest omits it; n2 was rewritten (cursor 9). The
/// reconcile pulls both in one request, and n3's signed delete removes it.
#[tokio::test]
async fn a_pack_held_row_the_feed_reports_deleted_is_removed_by_the_reconciles_one_pull() {
    let db = scratch_db("feed-deleted");
    let mut server = covered_vault(4, 10);
    server.live.retain(|(id, _)| id != "n3");
    server.live[1].1 = 9;
    server.deleted.push(("n3".into(), 6));
    server.signed_deletes.push("n3".into());
    let routes = Routes::new(server);
    run(&db, &routes, &[]).await;
    assert_eq!(routes.count("/sync/pull"), 1, "{:?}", routes.calls());
    assert!(!notes(&db)["n3"].0, "the signed delete removes n3");
    assert!(notes(&db)["n2"].0);
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
    assert_eq!(report.reconcile_kept, 1);
    assert!(remembered(&db).is_empty(), "no marker, nothing to remember");
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

/// #5247: a kept stale row reaches the shell's log as counts and the cursor,
/// not only stderr, which iOS does not keep.
#[tokio::test]
async fn a_kept_stale_row_is_told_to_the_diagnostics_sink() {
    #[derive(Default)]
    struct Captured(Mutex<Vec<CoreDiagnostic>>);
    impl DiagnosticsSink for Captured {
        fn record(&self, event: CoreDiagnostic) {
            self.0.lock().unwrap().push(event);
        }
    }

    let db = scratch_db("omitted-told");
    let mut server = covered_vault(4, 10);
    server.live.retain(|(id, _)| id != "n3");
    let mut clockless = marker("n3", 7, false);
    let fields = clockless.as_object_mut().expect("an object");
    fields.insert("clock".into(), Json::Null);
    fields.remove("deleteAttestation");
    server.markers.push(clockless);
    let routes = Routes::new(server);
    let sink = Arc::new(Captured::default());
    first_sync_observed(
        &db,
        &routes,
        &[],
        &RunDiagnostics::new(sink.clone()),
        Some(VAULT),
    )
    .run(1_800_000_000_000)
    .await
    .expect("the first sync finishes");

    let told: Vec<CoreDiagnostic> = sink
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|event| matches!(event, CoreDiagnostic::ReconcileKept { .. }))
        .copied()
        .collect();
    assert_eq!(
        told,
        vec![CoreDiagnostic::ReconcileKept {
            kept: 1,
            remembered: 1,
            non_envelope: 0,
            cursor: Some(4),
        }]
    );
}

/// A tombstone the server still holds arrives signed and deletes.
#[tokio::test]
async fn an_omitted_row_the_pull_answers_with_a_signed_delete_is_removed() {
    let (db, report) = omitted_n3("omitted-signed", false, |server| {
        server.signed_deletes.push("n3".into());
    })
    .await;
    assert!(!notes(&db)["n3"].0, "the signed delete removes n3");
    // The pull applies the signed delete itself (#5405), so it counts as
    // pulled; `reconcile_removed` counts marker removals.
    assert_eq!(
        (
            report.reconcile_pulled,
            report.reconcile_removed,
            report.reconcile_kept
        ),
        (1, 0, 0)
    );
}

/// §5.12.3: a shed tombstone converges through its attested marker, which
/// the pull is served only because it declares `purged_tombstones`.
#[tokio::test]
async fn an_omitted_row_the_pull_answers_with_an_attested_marker_is_removed() {
    let (db, report) = omitted_n3("omitted-marker", false, |server| {
        server.markers.push(marker("n3", 7, false));
    })
    .await;
    assert!(!notes(&db)["n3"].0, "the attested marker removes n3");
    assert_eq!(report.reconcile_removed, 1);
}

/// The same marker through the desktop's record pull, whose signer key comes
/// from the directory ([`DeviceA`]), not the cipher.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn an_omitted_row_the_pull_answers_with_an_attested_marker_is_removed_on_desktop() {
    let (db, report) = omitted_n3("omitted-marker-desktop", true, |server| {
        server.markers.push(marker("n3", 7, false));
    })
    .await;
    assert!(!notes(&db)["n3"].0, "the attested marker removes n3");
    assert_eq!(report.reconcile_removed, 1);
}

/// §5.12.3 for a task: its attested marker removes the pack-seeded row.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn an_omitted_task_the_pull_answers_with_an_attested_marker_is_removed() {
    let (db, report) = omitted_n3("omitted-task-marker", true, |server| {
        server.packs[0].entries.push(Entry::live("task:t9", 4));
        server.markers.push(marker("task:t9", 7, false));
    })
    .await;
    assert!(
        !live_row(&db, "task", "t9"),
        "the attested marker removes t9"
    );
    assert_eq!(report.reconcile_removed, 1, "n3 has no marker and stays");
}

/// #5247: the server replays a delete of the same id attested in another
/// vault of the account. v2 binds the vault, so it deletes nothing.
#[tokio::test]
async fn an_omitted_row_with_a_marker_attested_in_another_vault_is_kept() {
    let (db, report) = omitted_n3("omitted-other-vault", false, |server| {
        server.markers.push(marker_in("vault-b", "n3", 7, false));
    })
    .await;
    assert!(notes(&db)["n3"].0, "a delete from vault-b keeps n3");
    assert_eq!(report.reconcile_removed, 0);
}

/// #5247 compatibility: a v1 attestation from a build before #5247 still
/// removes the row.
#[tokio::test]
async fn an_omitted_row_the_pull_answers_with_a_v1_marker_is_removed() {
    let (db, report) = omitted_n3("omitted-v1-marker", false, |server| {
        server.markers.push(marker_in(None, "n3", 7, false));
    })
    .await;
    assert!(!notes(&db)["n3"].0, "the v1 marker removes n3");
    assert_eq!(report.reconcile_removed, 1);
}

/// #5247: a pull with no vault id cannot check a v2 attestation. Checked as v1
/// only, the marker is refused, n3 kept, and the reconcile marked done, so no
/// later run asks again. Instead the run fails and the reconcile stays due
/// (chapter 04 §4.8.4).
#[tokio::test]
async fn a_reconcile_with_no_vault_id_and_an_attested_marker_fails_and_stays_due() {
    let db = scratch_db("omitted-no-vault");
    let mut server = covered_vault(4, 10);
    server.live.retain(|(id, _)| id != "n3");
    server.markers.push(marker("n3", 7, false));
    let routes = Routes::new(server);
    let outcome = first_sync_observed(&db, &routes, &[], &RunDiagnostics::silent(), None)
        .run(1_800_000_000_000)
        .await;
    assert!(
        matches!(outcome, Err(FirstSyncError::Pull { .. })),
        "{outcome:?}"
    );
    assert!(notes(&db)["n3"].0, "no delete without its check: n3 stays");
    let reconciled = db
        .call_blocking(|conn| read_meta(conn, META_FIRST_SYNC_RECONCILED))
        .expect("read the meta row");
    assert_eq!(reconciled, None, "the reconcile stays due");
}

/// A marker whose attestation does not verify deletes nothing, nor does one
/// that claims a cursor no later than the row it would delete.
#[tokio::test]
async fn an_omitted_row_with_a_forged_or_stale_marker_is_kept() {
    let (db, report) = omitted_n3("omitted-forged", false, |server| {
        server.markers.push(marker("n3", 7, true));
        server.markers.push(marker("n3", 3, false));
    })
    .await;
    assert!(notes(&db)["n3"].0);
    assert_eq!(report.reconcile_removed, 0);
    assert_eq!(report.reconcile_kept, 1);
    // #5406: the unattested marker past the row is remembered with its clock;
    // the one at cursor 3 is older than the row and stands for nothing.
    assert_eq!(
        remembered(&db),
        vec![("n3".to_owned(), Some(r#"{"device-a":2}"#.to_owned()))]
    );
}

/// #5406: a clockless marker (a delete pushed before clocks were required)
/// can never be attested and the server accepts any update over it. The row
/// is kept and counted, and the marker is remembered so an edit of the row
/// applies the delete here instead of reversing it on every device.
#[tokio::test]
async fn an_omitted_row_with_a_clockless_marker_is_kept_and_remembered() {
    let (db, report) = omitted_n3("omitted-clockless", false, |server| {
        let mut entry = marker("n3", 7, false);
        let fields = entry.as_object_mut().expect("an object");
        fields.insert("clock".into(), Json::Null);
        fields.remove("deleteAttestation");
        server.markers.push(entry);
    })
    .await;
    assert!(notes(&db)["n3"].0);
    assert_eq!(report.reconcile_kept, 1);
    assert_eq!(remembered(&db), vec![("n3".to_owned(), None)]);
}

/// A marker deletes nothing when its attestation does not verify, its signer
/// is unknown, or its cursor is no later than the row it would delete.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn an_omitted_row_with_a_forged_unknown_or_stale_marker_is_kept() {
    let (db, report) = omitted_n3("omitted-forged", true, |server| {
        server.markers.push(marker("n3", 7, true));
        let mut unknown = marker("n3", 7, false);
        unknown["signerDeviceId"] = json!("device-z");
        server.markers.push(unknown);
        server.markers.push(marker("n3", 3, false));
    })
    .await;
    assert!(notes(&db)["n3"].0);
    assert_eq!(report.reconcile_removed, 0);
}

/// A row this device already changed (an outbox entry before the reconcile)
/// is never asked about, so its attested marker removes nothing.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn an_omitted_row_with_a_local_change_outranks_its_attested_marker() {
    let db = scratch_db("omitted-local-change");
    let mut server = covered_vault(4, 10);
    server.live.retain(|(id, _)| id != "n3");
    server.markers.push(marker("n3", 7, false));
    let routes = Routes::new(server);
    let first = first_sync_declaring(&db, &routes, &[], true);
    // The packs seed n3; the edit lands before the manifest is read.
    let edit = db.clone();
    *routes.on_manifest.lock().unwrap() = Some(Box::new(move || {
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
    let report = first
        .run(1_800_000_000_000)
        .await
        .expect("the first sync finishes");
    assert!(notes(&db)["n3"].0, "the local change keeps n3 live");
    assert_eq!(report.reconcile_removed, 0);
}

/// Whether the `item_type` row `item_id` is live with a payload.
#[cfg(feature = "markdown")]
fn live_row(db: &Db, item_type: &str, item_id: &str) -> bool {
    let (item_type, item_id) = (item_type.to_owned(), item_id.to_owned());
    db.call_blocking(move |conn| {
        Ok(conn
            .query_row(
                "SELECT deleted_at IS NULL AND payload_state <> 'metadata-only'
                 FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                [&item_type, &item_id],
                |row| row.get(0),
            )
            .unwrap())
    })
    .unwrap()
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

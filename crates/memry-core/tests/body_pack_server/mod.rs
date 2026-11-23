//! A sync server for the body pack tests (chapter 08 §8.4.3, §8.10, #5232).
//!
//! It holds each document's body rows (floor, snapshot, updates) and answers
//! every route a first sync reaches from them: the pack listing and the pack
//! bytes, the body manifest, the batch, snapshot and updates routes, and the
//! record feed, manifest and pull. Payloads are real chapter 04 §4.12
//! envelopes, so the reader's verify and open run as in production. Routing by
//! URL lets parallel downloads go in any order.

#![allow(dead_code)]

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log;
use memry_core::crdt::{DocumentRegistry, extract_text};
use memry_core::protocol::crdt_envelope::{CrdtMaterial, CrdtRequest, pack, unpack};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::pack::PACK_HEADER_SIZE;
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_debt;
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate, crdt_cursor_scope};
use memry_core::sync::driver::observer::Observers;
use memry_core::sync::first_sync::FirstSync;
use memry_core::sync::pack_bootstrap::PackBootstrap;
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::store;
use serde_json::{Value as Json, json};
use sha2::{Digest as _, Sha256};
use tokio::sync::Notify;
use yrs::updates::decoder::Decode as _;
use yrs::{
    Doc, ReadTxn as _, StateVector, Text as _, Transact as _, Update, Xml as _, XmlElementPrelim,
    XmlFragment as _, XmlTextPrelim,
};

pub const NOW_MS: i64 = 1_800_000_000_000;
const VAULT_KEY: [u8; 32] = [3u8; 32];
const SIGNER: &str = "device-a";
const R2: &str = "https://r2.example/packs/";

fn keypair() -> &'static (Vec<u8>, Vec<u8>) {
    static KEYS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    KEYS.get_or_init(|| {
        let (public, secret) =
            memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("keypair");
        (public, secret.to_vec())
    })
}

fn seal(doc_id: &str, update: &[u8]) -> Vec<u8> {
    pack(
        &CrdtRequest {
            note_id: doc_id,
            update,
            vault_key: &VAULT_KEY,
            signing_secret_key: &keypair().1,
        },
        &CrdtMaterial::random(),
    )
    .expect("seal")
}

/// `n` edits of one paragraph of a body the desktop write-back serializes
/// (§12.5.0's `blockGroup`, a block id): edit `i` appends the word `w<i>`.
fn edits(n: i64) -> Vec<Vec<u8>> {
    let doc = Doc::with_client_id(99);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut text = None;
    (1..=n)
        .map(|at| {
            let before = doc.transact().state_vector();
            {
                let mut txn = doc.transact_mut();
                match &text {
                    None => {
                        let group =
                            fragment.insert(&mut txn, 0, XmlElementPrelim::empty("blockGroup"));
                        let container =
                            group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
                        container.insert_attribute(&mut txn, "id", "block-1");
                        let paragraph =
                            container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
                        text = Some(paragraph.insert(&mut txn, 0, XmlTextPrelim::new("w1")));
                    }
                    Some(text) => text.push(&mut txn, &format!(" w{at}")),
                }
            }
            doc.transact().encode_diff_v1(&before)
        })
        .collect()
}

/// The merged state of `updates`.
fn state_of(updates: &[Vec<u8>]) -> Vec<u8> {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        for update in updates {
            txn.apply_update(Update::decode_v1(update).expect("an update"))
                .expect("apply");
        }
    }
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// The text after `n` edits.
pub fn words(n: i64) -> String {
    (1..=n)
        .map(|at| format!("w{at}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone)]
pub struct Snapshot {
    pub sequence_num: i64,
    pub revision: String,
    pub packed: Vec<u8>,
}

/// One document's body rows on the server.
#[derive(Clone)]
pub struct ServerDoc {
    pub id: String,
    pub floor: i64,
    pub snapshot: Option<Snapshot>,
    /// `sequenceNum` to sealed update.
    pub updates: BTreeMap<i64, Vec<u8>>,
    raw: Vec<Vec<u8>>,
}

impl ServerDoc {
    /// A document with `n` updates and no snapshot.
    pub fn new(id: &str, n: i64) -> Self {
        let raw = edits(n);
        let updates = raw
            .iter()
            .enumerate()
            .map(|(at, update)| (at as i64 + 1, seal(id, update)))
            .collect();
        Self {
            id: id.to_owned(),
            floor: 0,
            snapshot: None,
            updates,
            raw,
        }
    }

    /// Adds the snapshot of the first `at` edits.
    pub fn snapshot_at(mut self, at: i64) -> Self {
        let state = state_of(&self.raw[..at as usize]);
        self.snapshot = Some(Snapshot {
            sequence_num: at,
            revision: format!("rev-{}-{at}", self.id),
            packed: seal(&self.id, &state),
        });
        self
    }

    /// What a snapshot push with no update rows leaves on the server: the
    /// snapshot of every edit at `sequenceNum` 0, and no update row
    /// (`crdt-snapshot-write.ts`, the watermark of no rows is 0).
    pub fn snapshot_only(mut self) -> Self {
        let all = self.raw.len() as i64;
        self = self.snapshot_at(all);
        if let Some(snapshot) = self.snapshot.as_mut() {
            snapshot.sequence_num = 0;
        }
        self.updates.clear();
        self
    }

    /// A snapshot of the first `at` edits pushed with no update rows, so at
    /// `sequenceNum` 0, then the later edits pushed as updates 1, 2, ...
    pub fn snapshot_zero_then_updates(mut self, at: i64) -> Self {
        self = self.snapshot_at(at);
        if let Some(snapshot) = self.snapshot.as_mut() {
            snapshot.sequence_num = 0;
        }
        let id = self.id.clone();
        self.updates = self.raw[at as usize..]
            .iter()
            .enumerate()
            .map(|(i, update)| (i as i64 + 1, seal(&id, update)))
            .collect();
        self
    }

    /// Purges the updates through `floor`.
    pub fn purged_through(mut self, floor: i64) -> Self {
        self.updates.retain(|seq, _| *seq > floor);
        self.floor = floor;
        self
    }

    fn has_body_rows(&self) -> bool {
        self.snapshot.is_some() || !self.updates.is_empty() || self.floor > 0
    }

    fn max_sequence_num(&self) -> i64 {
        self.updates.keys().last().copied().unwrap_or(0)
    }

    fn snapshot_meta(&self) -> Json {
        self.snapshot.as_ref().map_or(
            Json::Null,
            |snapshot| json!({"sequenceNum": snapshot.sequence_num, "revision": snapshot.revision}),
        )
    }

    /// The updates a device holding this document should store: those above
    /// the snapshot it took, or all of them.
    pub fn expected_updates(&self) -> Vec<i64> {
        let from = self.snapshot.as_ref().map_or(0, |s| s.sequence_num);
        self.updates
            .keys()
            .copied()
            .filter(|seq| *seq > from)
            .collect()
    }
}

/// One pack entry: `(kind code, id, sourceKey, sortKey, meta, payload)`.
pub type PackItem = (u8, String, String, i64, Option<Json>, Vec<u8>);

pub fn snapshot_item(doc: &ServerDoc) -> PackItem {
    let snapshot = doc.snapshot.as_ref().expect("a snapshot");
    snapshot_item_as(doc, &snapshot.revision)
}

/// The document's snapshot bytes claimed at `revision`.
pub fn snapshot_item_as(doc: &ServerDoc, revision: &str) -> PackItem {
    let snapshot = doc.snapshot.as_ref().expect("a snapshot");
    (
        1,
        doc.id.clone(),
        format!("crdt/{}", doc.id),
        1_760_000_000,
        Some(json!({"sequenceNum": snapshot.sequence_num, "revision": revision})),
        snapshot.packed.clone(),
    )
}

pub fn update_item(doc_id: &str, sequence_num: i64, packed: &[u8]) -> PackItem {
    (
        2,
        doc_id.to_owned(),
        String::new(),
        1_760_000_000,
        Some(
            json!({"sequenceNum": sequence_num, "signerDeviceId": SIGNER,
                    "createdAt": 1_760_000_000}),
        ),
        packed.to_vec(),
    )
}

/// Every stored update of each document.
pub fn update_items(docs: &[&ServerDoc]) -> Vec<PackItem> {
    docs.iter()
        .flat_map(|doc| {
            doc.updates
                .iter()
                .map(|(seq, packed)| update_item(&doc.id, *seq, packed))
        })
        .collect()
}

pub fn snapshot_items(docs: &[&ServerDoc]) -> Vec<PackItem> {
    docs.iter().map(|doc| snapshot_item(doc)).collect()
}

/// Chapter 08 container bytes: header, payloads, index block, footer.
pub fn pack_bytes(items: &[PackItem]) -> Vec<u8> {
    let text = |out: &mut Vec<u8>, value: &str| {
        out.extend((value.len() as u16).to_be_bytes());
        out.extend(value.as_bytes());
    };
    let mut payload = Vec::new();
    let mut index = Vec::new();
    for (kind, id, source_key, sort_key, meta, bytes) in items {
        index.push(*kind);
        text(&mut index, id);
        text(&mut index, source_key);
        index.extend((*sort_key as u64).to_be_bytes());
        text(
            &mut index,
            &meta.as_ref().map(Json::to_string).unwrap_or_default(),
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
    out.extend((items.len() as u64).to_be_bytes());
    out.extend(index_offset.to_be_bytes());
    out.extend(b"MPAK");
    out.push(1);
    out
}

pub struct BodyPack {
    pub id: String,
    pub items: Vec<PackItem>,
}

impl BodyPack {
    pub fn new(id: &str, items: Vec<PackItem>) -> Self {
        Self {
            id: id.to_owned(),
            items,
        }
    }

    fn kind(&self) -> &'static str {
        match self.items.first().map(|item| item.0) {
            Some(2) => "crdt_update",
            _ => "crdt_snapshot",
        }
    }
}

/// How `GET /sync/crdt/manifest` answers.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Manifest {
    Served,
    /// A server before the route.
    Missing,
    /// Every page after the first answers 400.
    FailsAfterFirstPage,
    /// Every page after the first leaves out a document's `floor`.
    MalformedAfterFirstPage,
}

/// Changes the server between two requests of one pull.
pub type ServerHook = fn(&mut Server);

pub struct Server {
    pub docs: Vec<ServerDoc>,
    pub packs: Vec<BodyPack>,
    /// One record pack holds every document's record, with coverage to its
    /// end. Off for tests that drive the body phase alone.
    pub records: bool,
    pub manifest: Manifest,
    /// Documents per body manifest page, below the client's `limit`.
    pub manifest_page: usize,
    /// Documents a manifest read misses, as one created behind its cursor.
    pub manifest_misses: HashSet<String>,
    /// A URL substring whose request never answers: the process is killed
    /// while it waits.
    pub hang: Option<String>,
    /// Packs served with one payload byte flipped.
    pub corrupt: HashSet<String>,
    /// Packs listed but answering 404 on download.
    pub gone: HashSet<String>,
    /// Packs whose download the network drops.
    pub dropped: HashSet<String>,
    /// `GET /sync/packs` answers 404 from this call on (0 is the first).
    pub listing_missing_from: Option<usize>,
    listings: usize,
    /// Rewrites each batch answer, to send a malformed one.
    pub batch_rewrite: Option<fn(&mut Json)>,
    /// The next this many batch requests answer 429 with `Retry-After: 1`.
    pub batch_rate_limits: usize,
    /// The manifest pages after the first answer 429 with `Retry-After: 1`
    /// this many times.
    pub manifest_rate_limits: usize,
    /// Runs once before the first request whose URL holds the key, so a test
    /// can change the server between two requests of one pull.
    pub before: Vec<(String, ServerHook)>,
}

impl Server {
    pub fn new(docs: Vec<ServerDoc>, packs: Vec<BodyPack>) -> Self {
        Self {
            docs,
            packs,
            records: false,
            manifest: Manifest::Served,
            manifest_page: 1000,
            manifest_misses: HashSet::new(),
            hang: None,
            corrupt: HashSet::new(),
            gone: HashSet::new(),
            dropped: HashSet::new(),
            listing_missing_from: None,
            listings: 0,
            batch_rewrite: None,
            batch_rate_limits: 0,
            manifest_rate_limits: 0,
            before: Vec::new(),
        }
    }

    pub fn doc(&self, id: &str) -> &ServerDoc {
        self.docs.iter().find(|doc| doc.id == id).expect("a doc")
    }

    fn find(&self, id: &str) -> Option<&ServerDoc> {
        self.docs.iter().find(|doc| doc.id == id)
    }

    fn listing(&self, offset: usize) -> Json {
        let n = self.docs.len();
        let records = self.records.then(|| {
            json!({"id": "r0", "itemKind": "record", "packKey": "k", "minCursor": 1,
                   "maxCursor": n, "itemCount": n, "byteSize": 10, "createdAt": 1,
                   "url": format!("{R2}r0"), "expiresAt": 4_000_000_000i64,
                   "coverFrom": 0, "coverThrough": n})
        });
        let all: Vec<Json> = records
            .into_iter()
            .chain(self.packs.iter().map(|pack| {
                json!({"id": pack.id, "itemKind": pack.kind(), "packKey": "k",
                       "minCursor": 1, "maxCursor": 1, "itemCount": pack.items.len(),
                       "byteSize": 10, "createdAt": 1, "url": format!("{R2}{}", pack.id),
                       "expiresAt": 4_000_000_000i64})
            }))
            .collect();
        let page: Vec<&Json> = all.iter().skip(offset).take(50).collect();
        let mut body = json!({"packs": page, "serverTime": 1});
        if offset + 50 < all.len() {
            body["nextCursor"] = json!((offset + 50).to_string());
        }
        if self.records && offset == 0 {
            body["coverage"] =
                json!([{"itemKind": "record", "packedThrough": n, "coveredThrough": n}]);
        }
        body
    }

    fn record_pack(&self) -> Vec<u8> {
        let items: Vec<PackItem> = self
            .docs
            .iter()
            .enumerate()
            .map(|(at, doc)| {
                (
                    0,
                    format!("note:{}", doc.id),
                    format!("u/note/{}", doc.id),
                    at as i64 + 1,
                    Some(live_meta()),
                    BLOB.as_bytes().to_vec(),
                )
            })
            .collect();
        pack_bytes(&items)
    }

    fn body_manifest(&self, url: &str) -> Result<HttpResponse, TransportError> {
        let after = query(url, "cursor").unwrap_or_default();
        match self.manifest {
            Manifest::Missing => return response(404, "{}"),
            Manifest::FailsAfterFirstPage if !after.is_empty() => return response(400, "{}"),
            _ => {}
        }
        let limit: usize = query(url, "limit").map_or(1000, |l| l.parse().unwrap());
        let size = limit.min(self.manifest_page);
        let mut listed: Vec<&ServerDoc> = self
            .docs
            .iter()
            .filter(|doc| doc.has_body_rows() && doc.id.as_str() > after.as_str())
            .collect();
        listed.sort_by(|a, b| a.id.cmp(&b.id));
        let more = listed.len() > size;
        listed.truncate(size);
        let documents: Vec<Json> = listed
            .iter()
            .filter(|doc| !self.manifest_misses.contains(&doc.id))
            .map(|doc| {
                let mut document = json!({"noteId": doc.id, "floor": doc.floor,
                    "snapshot": doc.snapshot_meta(), "maxSequenceNum": doc.max_sequence_num()});
                if self.manifest == Manifest::MalformedAfterFirstPage && !after.is_empty() {
                    document.as_object_mut().unwrap().remove("floor");
                }
                document
            })
            .collect();
        let next = if more {
            json!(listed.last().unwrap().id)
        } else {
            Json::Null
        };
        response(
            200,
            &json!({"documents": documents, "nextCursor": next}).to_string(),
        )
    }

    fn update_page(&self, doc: Option<&ServerDoc>, since: i64, limit: usize) -> Json {
        let Some(doc) = doc else {
            return json!({"updates": [], "hasMore": false, "floor": 0});
        };
        let above: Vec<(&i64, &Vec<u8>)> = doc.updates.range(since + 1..).collect();
        let updates: Vec<Json> = above
            .iter()
            .take(limit)
            .map(|(seq, packed)| {
                json!({"sequenceNum": seq, "data": BASE64.encode(packed),
                       "signerDeviceId": SIGNER})
            })
            .collect();
        json!({"updates": updates, "hasMore": above.len() > limit, "floor": doc.floor})
    }

    fn answer(&mut self, request: &HttpRequest) -> Option<Result<HttpResponse, TransportError>> {
        let url = request.url.as_str();
        if let Some(at) = self
            .before
            .iter()
            .position(|(key, _)| url.contains(key.as_str()))
        {
            let (_, hook) = self.before.remove(at);
            hook(self);
        }
        if self.hang.as_ref().is_some_and(|hang| url.contains(hang)) {
            return None;
        }
        if let Some(id) = url.strip_prefix(R2) {
            if id == "r0" {
                return Some(bytes_response(self.record_pack()));
            }
            if self.dropped.contains(id) {
                return Some(Err(TransportError::Failed {
                    what: "the network dropped".to_owned(),
                }));
            }
            if self.gone.contains(id) {
                return Some(response(404, ""));
            }
            let pack = self.packs.iter().find(|pack| pack.id == id)?;
            let mut bytes = pack_bytes(&pack.items);
            if self.corrupt.contains(id) {
                bytes[PACK_HEADER_SIZE] ^= 0xff;
            }
            return Some(bytes_response(bytes));
        }
        if url.contains("/sync/packs") {
            self.listings += 1;
            if self
                .listing_missing_from
                .is_some_and(|from| self.listings > from)
            {
                return Some(response(404, "{}"));
            }
            let offset = query(url, "cursor").map_or(0, |offset| offset.parse().unwrap());
            return Some(response(200, &self.listing(offset).to_string()));
        }
        if url.contains("/sync/crdt/manifest") {
            if url.contains("cursor=") && self.manifest_rate_limits > 0 {
                self.manifest_rate_limits -= 1;
                return Some(rate_limited());
            }
            return Some(self.body_manifest(url));
        }
        if url.contains("/sync/crdt/updates/batch") {
            if self.batch_rate_limits > 0 {
                self.batch_rate_limits -= 1;
                return Some(rate_limited());
            }
            let asked = serde_json::from_slice::<Json>(request.body.as_deref().unwrap_or(b"{}"))
                .expect("a JSON body");
            let limit = asked["limit"].as_u64().unwrap_or(100) as usize;
            let (mut notes, mut metas) = (json!({}), json!({}));
            for note in asked["notes"].as_array().expect("notes") {
                let id = note["noteId"].as_str().expect("noteId");
                let since = note["since"].as_i64().expect("since");
                notes[id] = self.update_page(self.find(id), since, limit);
                metas[id] = self.find(id).map_or(Json::Null, ServerDoc::snapshot_meta);
            }
            let mut body = json!({"notes": notes, "snapshotMeta": metas});
            if let Some(rewrite) = self.batch_rewrite {
                rewrite(&mut body);
            }
            return Some(response(200, &body.to_string()));
        }
        if let Some(id) = url.split("/sync/crdt/snapshot/").nth(1) {
            let body = match self.find(id).and_then(|doc| doc.snapshot.as_ref()) {
                Some(snapshot) => json!({"snapshot": BASE64.encode(&snapshot.packed),
                    "sequenceNum": snapshot.sequence_num, "revision": snapshot.revision,
                    "signerDeviceId": SIGNER}),
                None => json!({"snapshot": null}),
            };
            return Some(response(200, &body.to_string()));
        }
        if url.contains("/sync/crdt/updates") {
            let id = query(url, "note_id").expect("note_id");
            let since = query(url, "since").map_or(0, |s| s.parse().unwrap());
            let limit = query(url, "limit").map_or(100, |l| l.parse().unwrap());
            let doc = self.find(&id);
            let mut body = self.update_page(doc, since, limit);
            body["snapshotMeta"] = doc.map_or(Json::Null, ServerDoc::snapshot_meta);
            return Some(response(200, &body.to_string()));
        }
        if url.contains("/sync/changes") {
            let head = self.docs.len();
            let body = json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": head});
            return Some(response(200, &body.to_string()));
        }
        if url.contains("/sync/manifest") {
            let items: Vec<Json> = self
                .docs
                .iter()
                .enumerate()
                .map(|(at, doc)| {
                    json!({"id": doc.id, "type": "note", "version": 1, "modifiedAt": 1,
                           "size": 1, "serverCursor": at + 1})
                })
                .collect();
            return Some(response(
                200,
                &json!({"items": items, "serverTime": 1}).to_string(),
            ));
        }
        panic!("unrouted request to {url}")
    }
}

fn query(url: &str, key: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix(&format!("{key}=")))
        .map(str::to_owned)
}

const BLOB: &str =
    r#"{"dataNonce":"AAAA","encryptedData":"AAAA","encryptedKey":"AAAA","keyNonce":"AAAA"}"#;

fn live_meta() -> Json {
    json!({"operation": "update", "cryptoVersion": 1, "signature": "AAAA",
           "signerDeviceId": SIGNER, "clock": {SIGNER: 1}})
}

fn response(status: u16, body: &str) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse {
        status,
        headers: Default::default(),
        body: body.as_bytes().to_vec(),
    })
}

fn rate_limited() -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse {
        status: 429,
        headers: [("retry-after".to_owned(), "1".to_owned())].into(),
        body: br#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#.to_vec(),
    })
}

fn bytes_response(body: Vec<u8>) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse {
        status: 200,
        headers: Default::default(),
        body,
    })
}

pub struct Routes {
    pub server: Mutex<Server>,
    calls: Mutex<Vec<String>>,
    pub hung: Notify,
}

impl Routes {
    pub fn new(server: Server) -> Arc<Self> {
        Arc::new(Self {
            server: Mutex::new(server),
            calls: Mutex::new(Vec::new()),
            hung: Notify::new(),
        })
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    pub fn count(&self, needle: &str) -> usize {
        self.calls()
            .iter()
            .filter(|url| url.contains(needle))
            .count()
    }

    pub fn clear_calls(&self) {
        self.calls.lock().unwrap().clear();
    }
}

#[async_trait::async_trait]
impl Transport for Routes {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        self.calls.lock().unwrap().push(request.url.clone());
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

/// The real §4.12 open over a directory of one device.
struct Directory;

impl CrdtCipher for Directory {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        if update.signer_device_id != Some(SIGNER) {
            return Err(EnvelopeError::SignatureInvalid);
        }
        unpack(update.packed, update.doc_id, &VAULT_KEY, &keypair().0)
    }

    fn signer_candidates(&self) -> Vec<String> {
        vec![SIGNER.to_owned()]
    }
}

/// Every record opens to a note modified inside the first sync's window.
struct Records;

impl RecordCipher for Records {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(json!({"title": format!("Note {}", envelope.id),
                  "modifiedAt": "2027-01-10T00:00:00.000Z"})
        .to_string()
        .into_bytes())
    }
}

/// A fresh vault directory and its `data.db`.
pub fn scratch(label: &str) -> (Db, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-body-packs-{label}-"))
        .tempdir()
        .expect("create the scratch directory")
        .keep();
    (open_data(&dir.join("data.db")).expect("open data.db"), dir)
}

fn http(routes: &Arc<Routes>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        Arc::clone(routes) as Arc<dyn Transport>,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ))
}

fn body_pull(db: &Db, http: &Arc<HttpClient>) -> Arc<BodyPull> {
    Arc::new(BodyPull::new(
        Arc::clone(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Directory),
    ))
}

/// The body pack phase alone, spilling under `dir`.
pub fn bootstrap(db: &Db, routes: &Arc<Routes>, dir: &std::path::Path) -> PackBootstrap {
    let http = http(routes);
    let bodies = body_pull(db, &http);
    PackBootstrap::new(http, db.clone(), bodies).with_spill_dir(dir.join("pack-spill"))
}

/// [`bootstrap`] whose body pull tells `observers`, as the desktop driver's does.
pub fn bootstrap_observed(
    db: &Db,
    routes: &Arc<Routes>,
    dir: &std::path::Path,
    observers: Arc<Observers>,
) -> PackBootstrap {
    let http = http(routes);
    let bodies = Arc::new(
        BodyPull::new(
            Arc::clone(&http),
            db.clone(),
            Declaration::subscribed(),
            Arc::new(Directory),
        )
        .with_observers(observers),
    );
    PackBootstrap::new(http, db.clone(), bodies).with_spill_dir(dir.join("pack-spill"))
}

/// A whole first sync, wired as `api/sync` wires it.
pub fn first_sync(db: &Db, routes: &Arc<Routes>, dir: &std::path::Path) -> FirstSync {
    first_sync_with(db, routes, dir, body_pull(db, &http(routes)))
}

/// [`first_sync`] whose body pull tells `observers`, as the desktop driver's does.
pub fn first_sync_observed(
    db: &Db,
    routes: &Arc<Routes>,
    dir: &std::path::Path,
    observers: Arc<Observers>,
) -> FirstSync {
    let bodies = BodyPull::new(
        http(routes),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Directory),
    )
    .with_observers(observers);
    first_sync_with(db, routes, dir, Arc::new(bodies))
}

fn first_sync_with(
    db: &Db,
    routes: &Arc<Routes>,
    dir: &std::path::Path,
    bodies: Arc<BodyPull>,
) -> FirstSync {
    let http = http(routes);
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Records),
    ));
    let packs = PackBootstrap::new(Arc::clone(&http), db.clone(), Arc::clone(&bodies))
        .with_spill_dir(dir.join("pack-spill"));
    FirstSync::new(pull, bodies, db.clone()).with_packs(Arc::new(packs))
}

/// The live note records the record passes would have left, and the
/// tombstones of `deleted`.
pub fn seed_records(db: &Db, live: &[&str], deleted: &[&str]) {
    let live: Vec<String> = live.iter().map(|id| (*id).to_owned()).collect();
    let deleted: Vec<String> = deleted.iter().map(|id| (*id).to_owned()).collect();
    db.call_blocking(move |conn| {
        for id in &live {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload_state, updated_at)
                 VALUES ('note', ?1, 'present', 1)",
                [id],
            )
            .expect("a live record");
            conn.execute("INSERT INTO notes (id, title) VALUES (?1, 't')", [id])
                .expect("a note");
        }
        for id in &deleted {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload_state, updated_at,
                                         deleted_at)
                 VALUES ('note', ?1, 'tombstone', 1, 1)",
                [id],
            )
            .expect("a tombstone");
        }
        Ok(())
    })
    .expect("seed the records");
}

pub fn text_of(db: &Db, doc_id: &str) -> String {
    let id = doc_id.to_owned();
    let blobs: Vec<Vec<u8>> = db
        .call_blocking(move |conn| {
            update_log::load_plan(conn, &id)
                .map(|plan| plan.blobs().into_iter().map(<[u8]>::to_vec).collect())
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("load plan");
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("device-reader", sink)
        .get_or_open(doc_id)
        .expect("open");
    for blob in &blobs {
        document.apply_durable_update(blob).expect("apply");
    }
    extract_text(&document).expect("extract")
}

pub fn cursor_of(db: &Db, doc_id: &str) -> Option<i64> {
    let scope = crdt_cursor_scope(doc_id);
    db.call_blocking(move |conn| store::read_cursor(conn, &scope))
        .expect("cursor")
        .map(|text| text.parse().expect("a number"))
}

/// The stored updates of a document, in order; the primary key makes a
/// duplicate impossible, so equality with the server's list is exactness.
pub fn update_seqs(db: &Db, doc_id: &str) -> Vec<i64> {
    let id = doc_id.to_owned();
    db.call_blocking(move |conn| {
        let mut statement = conn
            .prepare("SELECT seq FROM yjs_updates WHERE doc_id = ?1 ORDER BY seq")
            .unwrap();
        let seqs = statement
            .query_map([id], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<i64>, _>>()
            .unwrap();
        Ok(seqs)
    })
    .expect("the updates")
}

pub fn has_snapshot(db: &Db, doc_id: &str) -> bool {
    let id = doc_id.to_owned();
    db.call_blocking(move |conn| {
        Ok(
            update_log::snapshot(conn, update_log::Namespace::Server, &id)
                .expect("the snapshot")
                .is_some(),
        )
    })
    .expect("read the snapshot")
}

pub fn is_owed(db: &Db, doc_id: &str) -> bool {
    let id = doc_id.to_owned();
    db.call_blocking(move |conn| body_debt::is_owed(conn, &id))
        .expect("the debt")
}

/// The document holds exactly the server's body: its text, and its update
/// rows are the server's above the snapshot it took.
pub fn holds_exactly(db: &Db, doc: &ServerDoc, edits: i64) {
    assert_eq!(text_of(db, &doc.id), words(edits), "{}: text", doc.id);
    assert_eq!(
        update_seqs(db, &doc.id),
        doc.expected_updates(),
        "{}: update rows",
        doc.id
    );
}

//! A journal day's pictures across real devices (#5800, chapter 14 §14.7.4).
//!
//! A day names its pictures to peers in a `note` record under its own id,
//! `j<D>`, and the server keeps one record per id, last writer wins. Two
//! devices that add a picture to one day at once must both end up named on the
//! server, and a removal must stay removed, including against a record from an
//! Electron desktop, whose clock is the journal row's and can dominate a list
//! it never saw, and against lists that predate the rule.
//!
//! The devices are real (`Vault` + `VaultSync::sync_now`: sealing, signing,
//! SQLite, outbox, pull and push). The picture's upload is out of scope: each
//! trace stores the manifest the upload would have, then names the picture
//! through `notes::add_attachment_reference`, the call the upload ends with
//! (`api/sync/note_uploads.rs`). The server is the in-process one of
//! `journal_day_merge_devices.rs`, which follows
//! apps/sync-server/src/services/sync.ts.

use crate::http_fakes;
use crate::support;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, jwt};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::api::sync::VaultSync;
use memry_core::api::vault::Vault;
use memry_core::crypto::{keys, sodium};
use memry_core::domain::{attachments, journal, notes};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::Db;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::sync::apply;
use rusqlite::Connection;
use serde_json::{Value as Json, json};

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const DAY: &str = "j2026-06-09";

type Clock = BTreeMap<String, u64>;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| (*id).to_owned()).collect()
}

// ---------------------------------------------------------------- the server

struct Row {
    item: Json,
    clock: Option<Clock>,
    deleted_at: Option<i64>,
    cursor: i64,
}

#[derive(Default)]
struct State {
    rows: BTreeMap<(String, String), Row>,
    cursor: i64,
    crdt: BTreeMap<String, Vec<Json>>,
    /// registered device id -> signing public key
    devices: Vec<(String, Vec<u8>)>,
}

struct Server {
    state: Mutex<State>,
}

fn clock_of_json(value: Option<&Json>) -> Option<Clock> {
    value.and_then(|v| serde_json::from_value(v.clone()).ok())
}

fn detect_replay(incoming: Option<&Clock>, existing: Option<&Clock>) -> bool {
    match (incoming, existing) {
        (None, Some(_)) => true,
        (None, None) | (Some(_), None) => false,
        (Some(i), Some(e)) => !i.iter().any(|(k, v)| *v > e.get(k).copied().unwrap_or(0)),
    }
}

fn happens_after(incoming: &Clock, existing: &Clock) -> bool {
    let mut greater = false;
    for key in incoming.keys().chain(existing.keys()) {
        let i = incoming.get(key).copied().unwrap_or(0);
        let e = existing.get(key).copied().unwrap_or(0);
        if i < e {
            return false;
        }
        if i > e {
            greater = true;
        }
    }
    greater
}

fn should_reject_resurrection(
    operation: &str,
    existing_deleted_at: Option<i64>,
    incoming: Option<&Clock>,
    existing: Option<&Clock>,
) -> bool {
    if operation == "delete" || existing_deleted_at.is_none() {
        return false;
    }
    let (Some(incoming), Some(existing)) = (incoming, existing) else {
        return false;
    };
    !happens_after(incoming, existing)
}

fn json_response(status: u16, body: Json) -> HttpResponse {
    HttpResponse {
        status,
        headers: HashMap::new(),
        body: body.to_string().into_bytes(),
    }
}

fn query(path: &str) -> (String, HashMap<String, String>) {
    let (path, q) = path.split_once('?').unwrap_or((path, ""));
    let map = q
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    (path.to_owned(), map)
}

impl Server {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
        })
    }

    fn register(&self, id: &str, public: Vec<u8>) {
        let mut st = self.state.lock().unwrap();
        st.devices.push((id.to_owned(), public));
    }

    fn handle(
        &self,
        device: &str,
        method: &str,
        full_path: &str,
        body: Option<Json>,
    ) -> HttpResponse {
        let (path, q) = query(full_path);
        let mut st = self.state.lock().unwrap();
        match (method, path.as_str()) {
            ("GET", "/auth/devices") => {
                let devices: Vec<Json> = st
                    .devices
                    .iter()
                    .map(
                        |(id, public)| json!({"id": id, "signingPublicKey": BASE64.encode(public)}),
                    )
                    .collect();
                json_response(200, json!({ "devices": devices }))
            }
            ("GET", "/sync/changes") => {
                let after: i64 = q.get("cursor").and_then(|c| c.parse().ok()).unwrap_or(0);
                let mut rows: Vec<&Row> = st.rows.values().filter(|r| r.cursor > after).collect();
                rows.sort_by_key(|r| r.cursor);
                let next = rows.last().map_or(after, |r| r.cursor);
                let items: Vec<Json> = rows
                    .iter()
                    .filter(|r| r.deleted_at.is_none())
                    .map(|r| {
                        json!({"id": r.item["id"], "type": r.item["type"], "version": 1,
                               "modifiedAt": 1, "size": 1, "serverCursor": r.cursor})
                    })
                    .collect();
                let deleted: Vec<Json> = rows
                    .iter()
                    .filter(|r| r.deleted_at.is_some())
                    .map(|r| r.item["id"].clone())
                    .collect();
                json_response(
                    200,
                    json!({"items": items, "deleted": deleted, "hasMore": false,
                           "nextCursor": next, "noteBodies": []}),
                )
            }
            ("POST", "/sync/pull") => {
                let ids: Vec<String> = body
                    .as_ref()
                    .and_then(|b| b.get("itemIds"))
                    .and_then(Json::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Json::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                let mut rows: Vec<&Row> = st
                    .rows
                    .iter()
                    .filter(|((_, id), _)| ids.contains(id))
                    .map(|(_, r)| r)
                    .collect();
                rows.sort_by_key(|r| r.cursor);
                let items: Vec<Json> = rows.iter().map(|r| r.item.clone()).collect();
                json_response(200, json!({"items": items, "purgedTombstones": []}))
            }
            ("POST", "/sync/push") => {
                let items = body
                    .as_ref()
                    .and_then(|b| b.get("items"))
                    .and_then(Json::as_array)
                    .cloned()
                    .unwrap_or_default();
                let (mut accepted, mut rejected) = (Vec::new(), Vec::new());
                for item in items {
                    let id = item["id"].as_str().unwrap().to_owned();
                    let ty = item["type"].as_str().unwrap().to_owned();
                    let operation = item["operation"].as_str().unwrap_or("update").to_owned();
                    let clock = clock_of_json(item.get("clock"));
                    let key = (ty, id.clone());
                    if let Some(existing) = st.rows.get(&key) {
                        if detect_replay(clock.as_ref(), existing.clock.as_ref()) {
                            rejected.push(json!({"id": id, "reason": "SYNC_REPLAY_DETECTED"}));
                            continue;
                        }
                        if should_reject_resurrection(
                            &operation,
                            existing.deleted_at,
                            clock.as_ref(),
                            existing.clock.as_ref(),
                        ) {
                            rejected.push(json!({"id": id, "reason": "SYNC_DELETE_WINS"}));
                            continue;
                        }
                    }
                    st.cursor += 1;
                    let cursor = st.cursor;
                    let deleted_at = (operation == "delete")
                        .then(|| item.get("deletedAt").and_then(Json::as_i64).unwrap_or(1));
                    let mut stored = item.clone();
                    stored["serverCursor"] = json!(cursor);
                    st.rows.insert(
                        key,
                        Row {
                            item: stored,
                            clock,
                            deleted_at,
                            cursor,
                        },
                    );
                    accepted.push(json!(id));
                }
                let max = st.cursor;
                json_response(
                    200,
                    json!({"accepted": accepted, "rejected": rejected, "serverTime": 1,
                           "maxCursor": max}),
                )
            }
            ("POST", "/sync/crdt/updates/batch") => json_response(503, json!({})),
            ("POST", "/sync/crdt/updates") => {
                let body = body.unwrap();
                let doc = body["noteId"].as_str().unwrap().to_owned();
                let entries = st.crdt.entry(doc).or_default();
                let mut sequences = Vec::new();
                for data in body["updates"].as_array().unwrap() {
                    let seq = entries.len() as i64 + 1;
                    entries.push(json!({"sequenceNum": seq, "data": data,
                                        "signerDeviceId": device, "createdAt": 1}));
                    sequences.push(seq);
                }
                json_response(200, json!({ "sequences": sequences }))
            }
            ("GET", "/sync/crdt/updates") => {
                let doc = q.get("note_id").cloned().unwrap_or_default();
                let since: i64 = q.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
                let updates: Vec<Json> = st
                    .crdt
                    .get(&doc)
                    .map(|all| {
                        all.iter()
                            .filter(|u| u["sequenceNum"].as_i64().unwrap() > since)
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                json_response(200, json!({"updates": updates, "hasMore": false}))
            }
            ("GET", p) if p.starts_with("/sync/crdt/snapshot/") => {
                json_response(200, json!({"snapshot": null}))
            }
            // No picture bytes in these traces: a manifest is not there.
            (_, p) if p.starts_with("/sync/attachments/") => json_response(404, json!({})),
            _ => panic!("test server: unknown route {method} {full_path} from {device}"),
        }
    }

    /// The plaintext `attachmentReferences` of the server's live `id`, sorted.
    fn refs(&self, id: &str) -> Vec<String> {
        let st = self.state.lock().unwrap();
        let row = st
            .rows
            .get(&("note".to_owned(), id.to_owned()))
            .filter(|row| row.deleted_at.is_none())
            .unwrap_or_else(|| panic!("{id} is not live on the server"));
        let envelope = envelope::from_json(&row.item).unwrap();
        let signer = &st
            .devices
            .iter()
            .find(|(id, _)| *id == envelope.signer_device_id)
            .unwrap()
            .1;
        let vault_key = keys::derive_vault_key(&MASTER_KEY).unwrap();
        let plain = envelope::decrypt(&envelope, &vault_key[..], signer).unwrap();
        let payload: Json = serde_json::from_slice(&plain).unwrap();
        sorted(serde_json::from_value(payload["attachmentReferences"].clone()).unwrap())
    }
}

struct DeviceTransport {
    server: Arc<Server>,
    device: String,
}

#[async_trait::async_trait]
impl Transport for DeviceTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let path = request
            .url
            .strip_prefix(BASE)
            .unwrap_or(&request.url)
            .to_owned();
        let body = request
            .body
            .as_ref()
            .map(|b| serde_json::from_slice::<Json>(b).unwrap());
        Ok(self
            .server
            .handle(&self.device, &request.method, &path, body))
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

// ----------------------------------------------------------------- a device

struct Dev {
    registered: String,
    clock: String,
    _vault: Vault,
    side: Db,
    sync: Arc<VaultSync>,
}

impl Dev {
    fn new(server: &Arc<Server>, name: &str, seed: u8) -> Dev {
        let (public, secret) = sodium::sign_seed_keypair(&[seed; 32]).unwrap();
        let registered = format!("device-{name}");
        server.register(&registered, public.to_vec());
        let store = FakeSecureStore::new();
        store.put_text(
            SecureStoreKey::AccessToken,
            &jwt(
                json!({"sub": "user-1", "device_id": registered, "type": "access",
                        "exp": 9_999_999_999u64}),
            ),
        );
        store
            .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
            .unwrap();
        store
            .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
            .unwrap();
        let dir: PathBuf = support::scratch_dir("journal-day-pictures-devices").keep();
        std::fs::create_dir_all(&dir).unwrap();
        // Distinct vault ids: `pass_gate` is a process-global lock per vault id.
        let vault = Vault::open(
            format!(
                "vault-{name}-{}",
                dir.file_name().and_then(|n| n.to_str()).unwrap_or_default()
            ),
            dir.display().to_string(),
        )
        .unwrap();
        let side = memry_core::storage::open_data(&dir.join("data.db")).unwrap();
        let transport = Arc::new(DeviceTransport {
            server: server.clone(),
            device: registered.clone(),
        });
        let session = Arc::new(
            AuthSession::new(
                transport,
                store,
                BASE.to_string(),
                "ios".to_string(),
                DeviceDescriptor {
                    name: name.to_string(),
                    platform: DevicePlatform::Ios,
                    form_factor: None,
                    os_version: None,
                    app_version: "1.0.0".to_string(),
                    vault_id: None,
                },
                None,
            )
            .unwrap(),
        );
        let sync = vault.sync(session);
        Dev {
            registered,
            clock: keys::local_device_id_hex(&public).unwrap(),
            _vault: vault,
            side,
            sync,
        }
    }

    /// One pass; false when it moved nothing.
    async fn pass(&self) -> bool {
        match self.sync.sync_now().await {
            Ok(s) => s.pulled + s.deleted + s.pushed + s.bodies + s.rejected > 0,
            Err(_) => true,
        }
    }

    fn db<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, StorageError>) -> T {
        self.side.call_blocking(f).unwrap()
    }

    /// Names `id` on the day as an upload does once its manifest is stored.
    /// `manifest` false: the id came from elsewhere and this device cannot
    /// resolve it.
    fn add(&self, id: &str, manifest: bool) {
        let (id, clock) = (id.to_owned(), self.clock.clone());
        self.db(move |c| {
            if manifest {
                attachments::put_manifest(c, &id, "{}", 1, "picture.png", "image/png")?;
            }
            // A picture is added to a day the user has open.
            journal::open_day(c, &DAY[1..], &clock, now())?;
            notes::add_attachment_reference(c, DAY, &id, &clock, now()).map(|_| ())
        });
    }

    /// The user detaches `id` from the day.
    fn detach(&self, id: &str) {
        let (id, clock) = (id.to_owned(), self.clock.clone());
        self.db(move |c| {
            notes::remove_attachment_reference(c, DAY, &id, &clock, now()).map(|_| ())
        });
    }

    /// The day's pictures here, sorted.
    fn refs(&self) -> Vec<String> {
        sorted(self.db(|c| notes::read_attachment_references(c, DAY)))
    }

    /// The day's `note` record as this device would push it.
    fn record(&self) -> InboundRecord {
        let payload = self
            .db(|c| sync_items::push_payload(c, "note", DAY))
            .expect("the day has a note record");
        InboundRecord {
            item_type: "note".to_owned(),
            item_id: DAY.to_owned(),
            payload_json: payload,
            server_cursor: None,
            signer_device_id: Some(self.registered.clone()),
            updated_at: now(),
            deleted_at: None,
        }
    }

    /// Queued pushes of the day's `note` record.
    fn queued(&self) -> i64 {
        self.db(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_type = 'note' AND item_id = ?1",
                [DAY],
                |row| row.get(0),
            )
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
    }
}

/// Passes every device in rounds until a whole round moves nothing.
async fn settle(devices: &[&Dev]) {
    for _ in 0..6 {
        let mut moved = false;
        for dev in devices {
            moved |= dev.pass().await;
        }
        if !moved {
            return;
        }
    }
    panic!("the devices never settled");
}

/// A and B each add a picture to a day no device holds a record for, then
/// sync. A pushes first; B pulls A's record before it pushes its own.
async fn both_added(server: &Arc<Server>) -> (Dev, Dev) {
    let (a, b) = (Dev::new(server, "a", 1), Dev::new(server, "b", 2));
    a.add("pa", true);
    b.add("pb", true);
    settle(&[&a, &b]).await;
    (a, b)
}

#[tokio::test]
async fn two_devices_add_pictures_to_one_day_and_a_fresh_device_gets_both() {
    let server = Server::new();
    let (a, b) = both_added(&server).await;
    let both = names(&["pa", "pb"]);
    assert_eq!(server.refs(DAY), both, "the server's day");
    assert_eq!(a.refs(), both, "A's day");
    assert_eq!(b.refs(), both, "B's day");
    let fresh = Dev::new(&server, "c", 3);
    settle(&[&fresh]).await;
    assert_eq!(fresh.refs(), both, "a fresh device's day");
}

#[tokio::test]
async fn the_other_order_converges_and_a_stale_record_changes_nothing() {
    // B pushes first, so A is the one whose `pa` B could not have seen.
    let server = Server::new();
    let (a, b) = (Dev::new(&server, "a", 1), Dev::new(&server, "b", 2));
    a.add("pa", true);
    let a_record = a.record();
    b.add("pb", true);
    b.pass().await;
    a.pass().await;
    assert_eq!(a.refs(), names(&["pa", "pb"]), "A's day after B's list");
    settle(&[&a, &b]).await;
    assert_eq!(server.refs(DAY), names(&["pa", "pb"]), "the server's day");
    assert_eq!(b.refs(), names(&["pa", "pb"]), "B's day");
    // A's own first record, arriving late, adds nothing B does not hold.
    let applied = b.db(move |c| apply::apply_inbound_on(c, &a_record, now(), None));
    assert_eq!(applied, ApplyOutcome::Skipped);
}

#[tokio::test]
async fn a_picture_removed_by_a_device_that_saw_it_stays_removed() {
    let server = Server::new();
    let (a, b) = both_added(&server).await;
    b.detach("pa");
    settle(&[&a, &b]).await;
    assert_eq!(server.refs(DAY), names(&["pb"]), "the server's day");
    assert_eq!(a.refs(), names(&["pb"]), "A's day");
    let fresh = Dev::new(&server, "c", 3);
    settle(&[&fresh]).await;
    assert_eq!(fresh.refs(), names(&["pb"]), "a fresh device's day");
}

#[tokio::test]
async fn a_removal_concurrent_with_another_picture_stays_removed() {
    // B removes `pa`, which it saw, while A, offline, adds `pc`. A's list
    // still holds `pa`; A must keep `pc` and honour the removal.
    let server = Server::new();
    let (a, b) = both_added(&server).await;
    b.detach("pa");
    a.add("pc", true);
    b.pass().await;
    settle(&[&a, &b]).await;
    let want = names(&["pb", "pc"]);
    assert_eq!(server.refs(DAY), want, "the server's day");
    assert_eq!(a.refs(), want, "A's day");
    assert_eq!(b.refs(), want, "B's day");
}

#[tokio::test]
async fn an_id_this_device_cannot_resolve_is_kept_and_named_to_the_server() {
    // C names `px` and A applies it without its manifest. B, which never saw
    // `px`, names `pb` concurrently. A keeps `px` and names it again, so the
    // server's copy is not B's alone.
    let server = Server::new();
    let (a, c) = (Dev::new(&server, "a", 1), Dev::new(&server, "c", 3));
    c.add("px", true);
    settle(&[&c, &a]).await;
    assert_eq!(a.refs(), names(&["px"]), "A's day after C's");
    let b = Dev::new(&server, "b", 2);
    b.add("pb", true);
    let b_record = b.record();
    let applied = a.db(|c| apply::apply_inbound_on(c, &b_record, now(), Some(&a.clock)));
    assert_eq!(applied, ApplyOutcome::Applied);
    assert_eq!(
        a.refs(),
        names(&["pb", "px"]),
        "A keeps the id it cannot resolve"
    );
    b.pass().await;
    settle(&[&a, &b, &c]).await;
    assert_eq!(server.refs(DAY), names(&["pb", "px"]), "the server's day");
}

#[tokio::test]
async fn the_first_picture_of_a_day_creates_its_note_record() {
    let server = Server::new();
    let a = Dev::new(&server, "a", 1);
    a.add("pa", true);
    assert_eq!(a.refs(), names(&["pa"]));
    settle(&[&a]).await;
    assert_eq!(server.refs(DAY), names(&["pa"]), "the server's day");
}

#[tokio::test]
async fn two_devices_adding_to_a_day_that_already_has_a_record_keep_both() {
    // The day's record exists everywhere, so neither add creates it. Last
    // writer wins here would keep one of `pa` and `pb`.
    let server = Server::new();
    let (a, b) = (Dev::new(&server, "a", 1), Dev::new(&server, "b", 2));
    a.add("p0", true);
    settle(&[&a, &b]).await;
    assert_eq!(b.refs(), names(&["p0"]), "B's day before the adds");
    a.add("pa", true);
    b.add("pb", true);
    a.pass().await;
    settle(&[&b, &a]).await;
    let all = names(&["p0", "pa", "pb"]);
    assert_eq!(server.refs(DAY), all, "the server's day");
    assert_eq!(a.refs(), all, "A's day");
    assert_eq!(b.refs(), all, "B's day");
}

/// A `note j<D>` record as Electron desktop pushes it (`buildNotePushPayload`):
/// the journal's body and the journal row's clock, which here dominates every
/// clock `devices` hold for the record, though desktop never saw their lists.
fn desktop_record(list: &[&str], devices: &[&Dev]) -> InboundRecord {
    let mut clock = json!({"device-desktop": 3});
    for dev in devices {
        let payload: Json = serde_json::from_str(&dev.record().payload_json).unwrap();
        for (device, tick) in payload["clock"].as_object().unwrap() {
            clock[device] = json!(tick.as_u64().unwrap() + 40);
        }
    }
    let at = "2026-06-09T12:00:00.000Z";
    InboundRecord {
        item_type: "note".to_owned(),
        item_id: DAY.to_owned(),
        payload_json: json!({
            "title": "2026-06-09", "content": "# A day\n", "tags": [],
            "properties": {}, "pinnedTags": [], "emoji": null,
            "fileType": "markdown", "folderPath": "journal",
            "attachmentReferences": list, "clock": clock,
            "createdAt": at, "modifiedAt": at,
        })
        .to_string(),
        server_cursor: None,
        signer_device_id: Some("device-desktop".to_owned()),
        updated_at: now(),
        deleted_at: None,
    }
}

#[tokio::test]
async fn a_desktop_record_never_drops_a_picture_it_never_saw() {
    let server = Server::new();
    let a = Dev::new(&server, "a", 1);
    a.add("pa", true);
    settle(&[&a]).await;
    a.add("pc", true);
    let (record, clock) = (desktop_record(&["pa"], &[&a]), a.clock.clone());
    let applied = a.db(move |c| apply::apply_inbound_on(c, &record, now(), Some(&clock)));
    assert_eq!(applied, ApplyOutcome::Applied);
    assert_eq!(a.refs(), names(&["pa", "pc"]), "A's day keeps `pc`");
    assert_eq!(a.queued(), 1, "A owes the server `pc`");
    settle(&[&a]).await;
    assert_eq!(server.refs(DAY), names(&["pa", "pc"]), "the server's day");
}

#[tokio::test]
async fn a_desktop_record_never_brings_back_a_picture_a_core_device_removed() {
    let server = Server::new();
    let (a, b) = both_added(&server).await;
    a.detach("pb");
    settle(&[&a, &b]).await;
    assert_eq!(b.refs(), names(&["pa"]), "B took A's removal");
    // Desktop unioned `pb` in before the removal and pushes its list again.
    for dev in [&a, &b] {
        let record = desktop_record(&["pa", "pb"], &[&a, &b]);
        let applied = dev.db(move |c| apply::apply_inbound_on(c, &record, now(), Some(&dev.clock)));
        assert_eq!(applied, ApplyOutcome::Applied);
        assert_eq!(dev.refs(), names(&["pa"]), "`pb` stays removed");
    }
    settle(&[&a, &b]).await;
    assert_eq!(server.refs(DAY), names(&["pa"]), "the server's day");
}

#[tokio::test]
async fn a_removal_stands_in_a_day_that_predates_the_rule() {
    // Both devices hold the day as an older build left it: a list, no
    // removals. B removes `pa` while A, offline, adds `pc`.
    let server = Server::new();
    let (a, b) = (Dev::new(&server, "a", 1), Dev::new(&server, "b", 2));
    let old = InboundRecord {
        signer_device_id: Some("device-old".to_owned()),
        payload_json: json!({
            "title": "2026-06-09", "fileType": "markdown", "folderPath": "journal",
            "attachmentReferences": ["pa", "pb"], "clock": {"device-old": 1},
            "createdAt": "2026-06-09T08:00:00.000Z",
            "modifiedAt": "2026-06-09T08:00:00.000Z",
        })
        .to_string(),
        ..desktop_record(&[], &[])
    };
    for dev in [&a, &b] {
        let old = old.clone();
        let applied = dev.db(move |c| apply::apply_inbound_on(c, &old, now(), Some(&dev.clock)));
        assert_eq!(applied, ApplyOutcome::Applied);
    }
    b.detach("pa");
    a.add("pc", true);
    b.pass().await;
    settle(&[&a, &b]).await;
    let want = names(&["pb", "pc"]);
    assert_eq!(server.refs(DAY), want, "the server's day");
    assert_eq!(a.refs(), want, "A's day");
    assert_eq!(b.refs(), want, "B's day");
}

#[tokio::test]
async fn a_dominated_copy_without_this_devices_removal_is_owed_one() {
    // The server's copy may be an older one of A's own that never saw `pb`'s
    // removal; A holds the newer record, so the copy is a skip, yet A owes it.
    let server = Server::new();
    let a = Dev::new(&server, "a", 1);
    a.add("pa", true);
    a.add("pb", true);
    settle(&[&a]).await;
    let stale = a.record();
    a.detach("pb");
    settle(&[&a]).await;
    assert_eq!(a.queued(), 0, "A pushed its removal");
    let clock = a.clock.clone();
    a.db(move |c| apply::apply_inbound_on(c, &stale, now(), Some(&clock)));
    assert_eq!(a.refs(), names(&["pa"]), "`pb` stays removed");
    assert_eq!(a.queued(), 1, "A owes the server its removal");
}

#[tokio::test]
async fn a_removal_outlives_a_desktop_delete_of_the_days_record() {
    // Desktop's tombstone carries no removals. A's next picture creates the
    // record over it, and `pb`'s removal still stands against desktop's list.
    let server = Server::new();
    let a = Dev::new(&server, "a", 1);
    a.add("pa", true);
    a.add("pb", true);
    a.detach("pb");
    settle(&[&a]).await;
    let tombstone = InboundRecord {
        payload_json: json!({"clock": {"device-desktop": 90}}).to_string(),
        deleted_at: Some(now()),
        ..desktop_record(&[], &[])
    };
    let clock = a.clock.clone();
    let applied = a.db(move |c| apply::apply_inbound_on(c, &tombstone, now(), Some(&clock)));
    assert_eq!(applied, ApplyOutcome::Applied);
    a.add("pc", true);
    let record = desktop_record(&["pb", "pc"], &[&a]);
    let clock = a.clock.clone();
    a.db(move |c| apply::apply_inbound_on(c, &record, now(), Some(&clock)));
    assert_eq!(a.refs(), names(&["pc"]), "`pb` stays removed");
}

#[tokio::test]
async fn a_picture_named_on_a_deleted_day_is_refused_and_writes_nothing() {
    // Whoever names it (an upload landing, a merge's carry, an inbox
    // filing), a deleted day gets no record: one would bring its pictures
    // back on every device.
    let server = Server::new();
    let a = Dev::new(&server, "a", 1);
    let clock = a.clock.clone();
    let refused = a.side.call_blocking(move |c| {
        journal::open_day(c, &DAY[1..], &clock, now())?;
        journal::delete_day(c, &DAY[1..], &clock, now())?;
        notes::add_attachment_reference(c, DAY, "pa", &clock, now())
    });
    assert!(refused.is_err(), "the deleted day is refused");
    let records = a.db(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM sync_items WHERE item_type = 'note' AND item_id = ?1",
            [DAY],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    });
    assert_eq!(records, 0, "no record of the deleted day");
    assert_eq!(a.queued(), 0, "nothing to push");
}

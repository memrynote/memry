//! The journal day merge across two real devices (§1.9.1 step 6, #5659).
//!
//! Device A holds a foreign journal id `F` for day `D`, as a pre-#2939 build
//! projected it. Device B merges `F` into `j<D>`, pushes `j<D>`, then `F`'s
//! tombstone. Each trace runs in both orders A can pull them in: `j<D>` first,
//! the order of B's push, and the tombstone first, when B touches `j<D>` again.
//! A tag B never saw ends up in `j<D>` everywhere; a tag B removed after it saw
//! it stays removed.
//!
//! Both devices are real (`Vault` + `VaultSync::sync_now`: sealing, signing,
//! SQLite, outbox, pull, body step and the day merge drain). The server is in
//! process and follows apps/sync-server/src/services/sync.ts: rows keyed by
//! (type, id), one global cursor per accepted item, `detectReplay`,
//! `shouldRejectResurrection`, and a feed ordered by cursor.

mod http_fakes;

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, jwt};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::api::sync::VaultSync;
use memry_core::api::vault::Vault;
use memry_core::crdt::update_log;
use memry_core::crypto::{keys, sodium};
use memry_core::domain::attachments;
use memry_core::domain::journal_ops::metadata;
use memry_core::domain::tags;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::Db;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::store;
use rusqlite::Connection;
use serde_json::{Value as Json, json};
use tokio::sync::Notify;
use yrs::updates::decoder::Decode as _;
use yrs::{GetString as _, ReadTxn as _, StateVector, Text as _, Transact as _, Update};

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const DATE: &str = "2026-06-09";
const DAY: &str = "j2026-06-09";
const F: &str = "vcpzueguep8y";
const PICTURE: &str = "c2aaafaa721c3893a1fb8ca144718a1e";
const OWN: &str = "0b5d3c1e9f2a4b6c8d0e1f2a3b4c5d6e";

static SCRATCH: AtomicU64 = AtomicU64::new(0);
type Clock = BTreeMap<String, u64>;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn failed(error: impl std::fmt::Display) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A real Yjs update writing `text` into root `t`.
fn text_update(client: u64, text: &str) -> Vec<u8> {
    let doc = yrs::Doc::with_client_id(client);
    let body = doc.get_or_insert_text("t");
    body.insert(&mut doc.transact_mut(), 0, text);
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

// ---------------------------------------------------------------- the server

struct Row {
    item: Json,
    clock: Option<Clock>,
    deleted_at: Option<i64>,
    cursor: i64,
}

/// A request of `device` whose "METHOD path" contains `needle`: held until
/// `release` (a hook), or lost before the server (a drop).
struct Trap {
    device: String,
    needle: String,
    hook: Option<(Arc<Notify>, Arc<Notify>)>,
    used: bool,
}

#[derive(Default)]
struct State {
    rows: BTreeMap<(String, String), Row>,
    cursor: i64,
    crdt: BTreeMap<String, Vec<Json>>,
    /// registered device id -> signing public key
    devices: Vec<(String, Vec<u8>)>,
    traps: Vec<Trap>,
    /// Attachment uploads fail with 503 while set: the device is offline
    /// for them.
    attachments_down: bool,
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

    fn trap(&self, device: &str, needle: &str, hook: Option<(Arc<Notify>, Arc<Notify>)>) {
        self.state.lock().unwrap().traps.push(Trap {
            device: device.to_owned(),
            needle: needle.to_owned(),
            hook,
            used: false,
        });
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
            // Accepts every upload step; only the reference names the bytes.
            (_, p) if p.starts_with("/sync/attachments/") => {
                if st.attachments_down {
                    json_response(503, json!({}))
                } else if p.ends_with("/upload/initiate") {
                    json_response(
                        200,
                        json!({"sessionId": "upload-1", "expiresAt": 9_999_999_999_000i64}),
                    )
                } else {
                    json_response(200, json!({"success": true}))
                }
            }
            _ => panic!("test server: unknown route {method} {full_path} from {device}"),
        }
    }

    /// The plaintext tags of the server's live `id`, sorted.
    fn tags(&self, id: &str) -> Vec<String> {
        let st = self.state.lock().unwrap();
        let row = st
            .rows
            .iter()
            .find(|((_, i), _)| i == id)
            .map(|(_, r)| r)
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
        let mut tags: Vec<String> = payload["tags"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.as_str().map(str::to_owned))
            .collect();
        tags.sort();
        tags
    }

    fn attachments_down(&self, down: bool) {
        self.state.lock().unwrap().attachments_down = down;
    }

    fn max_cursor(&self) -> i64 {
        self.state.lock().unwrap().cursor
    }

    fn cursor_of(&self, id: &str) -> i64 {
        let st = self.state.lock().unwrap();
        st.rows
            .iter()
            .find(|((_, i), _)| i == id)
            .map(|(_, r)| r.cursor)
            .unwrap_or_else(|| panic!("{id} is not on the server"))
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
        let label = format!("{} {}", request.method, path);
        let trap = {
            let mut st = self.server.state.lock().unwrap();
            st.traps
                .iter_mut()
                .find(|t| !t.used && t.device == self.device && label.contains(&t.needle))
                .map(|t| {
                    t.used = true;
                    t.hook.clone()
                })
        };
        match trap {
            Some(Some((arrived, release))) => {
                arrived.notify_one();
                release.notified().await;
            }
            Some(None) => return Err(TransportError::Cancelled),
            None => {}
        }
        let body = request
            .body
            .as_ref()
            // A chunk's body is bytes, not JSON.
            .and_then(|b| serde_json::from_slice::<Json>(b).ok());
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
        let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
        let dir: PathBuf = std::env::temp_dir().join(format!(
            "memry-day-merge-devices-{name}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // Distinct vault ids: `pass_gate` is a process-global lock per vault id.
        let vault =
            Vault::open(format!("vault-{name}-{unique}"), dir.display().to_string()).unwrap();
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

    fn day(&self) -> Vec<String> {
        let mut day = self.db(|c| tags::list(c, "journal", DAY));
        day.sort();
        day
    }

    /// The real local edit: routes to the row that holds the day.
    fn set_tags(&self, want: &[&str]) {
        let want: Vec<String> = want.iter().map(|t| t.to_string()).collect();
        let clock = self.clock.clone();
        self.db(move |c| metadata::set_tags(c, DATE, &want, &clock, now()).map(|_| ()));
    }

    /// `j<D>`'s text in root `t`: every update of it, server then local.
    fn day_text(&self) -> String {
        let blobs: Vec<Vec<u8>> = self.db(|c| {
            Ok(update_log::load_plan(c, DAY)
                .map_err(failed)?
                .blobs()
                .into_iter()
                .map(<[u8]>::to_vec)
                .collect())
        });
        let doc = yrs::Doc::new();
        let body = doc.get_or_insert_text("t");
        for blob in blobs {
            doc.transact_mut()
                .apply_update(Update::decode_v1(&blob).unwrap())
                .unwrap();
        }
        body.get_string(&doc.transact())
    }

    /// Text typed into `F` and not pushed yet: its update and the queued
    /// row that pushes it, as `seed_foreign` writes the held body.
    fn type_into_foreign(&self, text: &str) {
        let update = text_update(8, text);
        self.db(move |conn| {
            let body = update.clone();
            outbox::commit(conn, &Change::crdt_update("journal", F, update), 2, |tx| {
                update_log::append_local_update_in(tx, F, &body, 2)
                    .map(|_| ())
                    .map_err(failed)
            })
        });
    }

    /// Removes `tag` from the day (a user edit).
    fn remove(&self, tag: &str) {
        let rest: Vec<String> = self.day().into_iter().filter(|t| t != tag).collect();
        let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
        self.set_tags(&rest);
    }

    /// Sets `j<D>`'s aliases to `alias`, another record field, so it takes a
    /// newer cursor.
    fn bump_alias(&self, alias: &str) {
        let (clock, aliases) = (self.clock.clone(), vec![alias.to_owned()]);
        self.db(move |c| metadata::set_aliases(c, DATE, &aliases, &clock, now()).map(|_| ()));
    }

    /// A pre-#2939 install's projection of the foreign id `F` for the day,
    /// its body, and the queued upserts that push them.
    fn seed_foreign(&self, held_tags: &[&str], clock: Clock) {
        let payload =
            json!({"date": DATE, "content": "", "tags": held_tags, "clock": clock}).to_string();
        self.db(move |conn| {
            let record = InboundRecord {
                item_type: "journal".to_owned(),
                item_id: F.to_owned(),
                payload_json: payload,
                server_cursor: None,
                signer_device_id: Some("device-a".to_owned()),
                updated_at: 1,
                deleted_at: None,
            };
            assert_eq!(
                sync_items::apply_remote(conn, &record, 1)?,
                ApplyOutcome::Applied
            );
            let update = text_update(7, "held");
            let body = update.clone();
            outbox::commit(conn, &Change::crdt_update("journal", F, update), 1, |tx| {
                update_log::append_local_update_in(tx, F, &body, 1)
                    .map(|_| ())
                    .map_err(failed)
            })?;
            outbox::commit(conn, &Change::upsert("journal", F), 1, |_| Ok(()))
        });
    }

    /// The `note` record desktop pushes under `id` once `picture` uploaded
    /// to it (`recordOnNote`), and the queued upsert that pushes it.
    fn seed_picture(&self, id: &'static str, picture: &str, clock: Clock) {
        let payload = json!({
            "title": DATE, "fileType": "markdown", "folderPath": "journal",
            "attachmentReferences": [picture], "clock": clock,
            "createdAt": "2026-06-09T08:00:00.000Z", "modifiedAt": "2026-06-09T08:00:00.000Z",
        })
        .to_string();
        self.db(move |conn| {
            let record = InboundRecord {
                item_type: "note".to_owned(),
                item_id: id.to_owned(),
                payload_json: payload,
                server_cursor: None,
                signer_device_id: Some("device-a".to_owned()),
                updated_at: 1,
                deleted_at: None,
            };
            assert_eq!(
                sync_items::apply_remote(conn, &record, 1)?,
                ApplyOutcome::Applied
            );
            outbox::commit(conn, &Change::upsert("note", id), 1, |_| Ok(()))
        });
    }

    /// A picture attached to the day the device holds as `F`, as the day
    /// page attaches (`upload_attachment`); its id.
    async fn attach_to_foreign(&self) -> String {
        self.sync
            .upload_attachment(
                F.to_owned(),
                "photo.png".to_owned(),
                "image/png".to_owned(),
                b"a picture taken offline".to_vec(),
            )
            .await
            .unwrap()
    }

    /// Deletes the `note` record under `id` (a user delete).
    fn delete_note(&self, id: &'static str) {
        let clock = self.clock.clone();
        self.db(move |c| memry_core::domain::notes::delete(c, id, &clock, now()).map(|_| ()));
    }

    /// The pictures opening `j<D>` fetches (`fetch_note_manifests(DAY)`).
    fn day_pictures(&self) -> Vec<String> {
        self.db(|c| attachments::for_note(c, DAY))
            .into_iter()
            .map(|row| row.attachment_id)
            .collect()
    }

    /// The device already pulled the feed through `cursor`, as an install
    /// that held `F` long before has: it does not pull its own `F` back.
    fn pulled_through(&self, cursor: i64) {
        self.db(move |c| {
            store::write_cursor(
                c,
                store::RECORD_CURSOR_SCOPE,
                Some(&cursor.to_string()),
                now(),
            )
        });
    }
}

// ------------------------------------------------------------------- a world

#[derive(Clone, Copy, Debug, PartialEq)]
enum Order {
    /// `j<D>` has a lower cursor than `F`'s tombstone: the order of B's push.
    DayFirst,
    /// `F`'s tombstone has a lower cursor than `j<D>`'s latest version.
    TombstoneFirst,
}

struct World {
    server: Arc<Server>,
    a: Dev,
    b: Dev,
}

impl World {
    /// A holds `F` with `held` at `{A:1}` and pushed it with its body. Each
    /// device ran a pass on the empty server first: a first pass restarts the
    /// feed, which a device that held `F` did long ago.
    async fn new(held: &[&str]) -> World {
        let server = Server::new();
        let a = Dev::new(&server, "a", 21);
        let b = Dev::new(&server, "b", 22);
        a.pass().await;
        b.pass().await;
        a.seed_foreign(held, BTreeMap::from([(a.clock.clone(), 1)]));
        a.pass().await;
        a.pulled_through(server.max_cursor());
        World { server, a, b }
    }

    /// After B's pass that merged `F`: in `TombstoneFirst`, B touches `j<D>`
    /// again and pushes it past the tombstone. Asserts the order A will pull.
    async fn order(&self, order: Order) {
        if order == Order::TombstoneFirst {
            self.b.bump_alias("later");
            self.b.pass().await;
        }
        let day_first = self.server.cursor_of(DAY) < self.server.cursor_of(F);
        assert_eq!(day_first, order == Order::DayFirst, "the feed order");
    }

    /// Passes A then B in rounds until a whole round moves nothing.
    async fn settle(&self) {
        for _ in 0..6 {
            let a = self.a.pass().await;
            let b = self.b.pass().await;
            if !a && !b {
                return;
            }
        }
        panic!("the devices never settled");
    }

    /// `j<D>` on A, on B and on the server.
    fn assert_day(&self, want: &[&str]) {
        let want: Vec<String> = want.iter().map(|t| t.to_string()).collect();
        assert_eq!(self.a.day(), want, "A's j<D>");
        assert_eq!(self.b.day(), want, "B's j<D>");
        assert_eq!(self.server.tags(DAY), want, "the server's j<D>");
    }
}

/// `dev`'s pass, with `gap` run when its first request containing `needle`
/// arrives, before the server answers it.
async fn pass_with_gap<G: Future<Output = ()>>(world: &World, dev: &Dev, needle: &str, gap: G) {
    let (arrived, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    world.server.trap(
        &dev.registered,
        needle,
        Some((arrived.clone(), release.clone())),
    );
    let gap_work = async {
        arrived.notified().await;
        gap.await;
        release.notify_one();
    };
    tokio::time::timeout(Duration::from_secs(300), async {
        tokio::join!(dev.pass(), gap_work)
    })
    .await
    .expect("the gap never opened or never closed");
}

// ----------------------------------------------------------------- the traces

/// (a) The review trace of #5656: A pushes `c` after B pulled `F` and before
/// B pushes its merge. B's tombstone, clocked before A's push, replaces it on
/// the server, so `c` reached no other device.
async fn pushed_then_overwritten(order: Order) {
    let w = World::new(&["a", "b"]).await;
    pass_with_gap(&w, &w.b, "POST /sync/push", async {
        w.a.set_tags(&["a", "b", "c"]);
        w.a.pass().await;
    })
    .await;
    w.order(order).await;
    w.settle().await;
    w.assert_day(&["a", "b", "c"]);
}

/// (B4) B merges `F`, then the user removes `b` from `j<D>` on B. A held `b`
/// as pulled, so B saw it: it stays removed. Day first, A pulls the merge
/// before the removal: an edit B makes after its merge queues `j<D>` behind
/// `F`'s delete, so B can never push a `j<D>` without `b` ahead of it.
async fn removed_after_the_merge(order: Order) {
    let w = World::new(&["a", "b"]).await;
    w.b.pass().await;
    if order == Order::DayFirst {
        w.order(order).await;
        w.a.pass().await;
    }
    w.b.remove("b");
    w.b.pass().await;
    if order == Order::TombstoneFirst {
        w.order(order).await;
    }
    w.settle().await;
    w.assert_day(&["a"]);
}

/// (c1-c3) A adds tags offline, then B merges `F` without them. c2: B's merge
/// lands while A's pass is between its pull and its push, so A's push is
/// refused (`SYNC_DELETE_WINS`) and the feed brings the tombstone again.
async fn added_offline(order: Order, offline: &[&[&str]], in_the_gap: bool) {
    let w = World::new(&["a", "b"]).await;
    for edit in offline {
        w.a.set_tags(edit);
    }
    if in_the_gap {
        pass_with_gap(&w, &w.a, "POST /sync/push", async {
            w.b.pass().await;
            w.order(order).await;
        })
        .await;
    } else {
        w.b.pass().await;
        w.order(order).await;
    }
    w.settle().await;
    w.assert_day(offline.last().unwrap());
}

/// (c5) A types into `F` offline, then B merges `F` without that text. Day
/// first, `j<D>` displaces `F` before its tombstone arrives, and the
/// tombstone must not purge the body the drain folds into the day. In the
/// gap, A pushes the text to `F` after B merged it, where no device reads it.
async fn typed_offline(order: Order, in_the_gap: bool) {
    let w = World::new(&["a", "b"]).await;
    w.a.type_into_foreign("offline ");
    if in_the_gap {
        pass_with_gap(&w, &w.a, "POST /sync/crdt/updates", async {
            w.b.pass().await;
            w.order(order).await;
        })
        .await;
    } else {
        w.b.pass().await;
        w.order(order).await;
    }
    w.settle().await;
    // The note body feed tells B that `j<D>`'s body changed; this server
    // sends none, so a record edit makes B pull it.
    w.a.bump_alias("read");
    w.settle().await;
    for (device, text) in [("A", w.a.day_text()), ("B", w.b.day_text())] {
        assert!(text.contains("offline "), "{device}'s j<D>: {text:?}");
        assert!(text.contains("held"), "{device}'s j<D>: {text:?}");
    }
    w.assert_day(&["a", "b"]);
}

/// (#5777) A named a picture under `F`; B merges `F`. A day's pictures are
/// fetchable wherever the day is: a device that never held `F` opens `j<D>`
/// and wants the picture, and the devices settle with no push loop.
#[tokio::test]
async fn a_fresh_device_fetches_the_merged_days_pictures() {
    let w = World::new(&["a"]).await;
    w.a.seed_picture(F, PICTURE, BTreeMap::from([(w.a.clock.clone(), 1)]));
    w.a.pass().await;
    w.b.pass().await;
    w.settle().await;
    assert_eq!(w.b.day_pictures(), [PICTURE], "B's j<D>");
    assert_eq!(w.a.day_pictures(), [PICTURE], "A's j<D>");
    fresh_device_wants(&w, &[PICTURE]).await;
}

/// (#5777) `j<D>` already names a picture of its own: the merge adds `F`'s
/// to the list and drops none.
#[tokio::test]
async fn the_merge_keeps_the_days_own_pictures() {
    let w = World::new(&["a"]).await;
    let clock = BTreeMap::from([(w.a.clock.clone(), 1)]);
    w.a.seed_picture(F, PICTURE, clock.clone());
    w.a.seed_picture(DAY, OWN, clock);
    w.a.pass().await;
    w.b.pass().await;
    w.settle().await;
    let mut want = [OWN, PICTURE];
    want.sort();
    for (device, mut got) in [("A", w.a.day_pictures()), ("B", w.b.day_pictures())] {
        got.sort();
        assert_eq!(got, want, "{device}'s j<D>");
    }
    fresh_device_wants(&w, &want).await;
}

/// (#5801) A picture attached to `F` offline is still queued when the merge
/// settles, and the pass uploads after the merge: the upload names `j<D>`,
/// not `F`. With `pushed`, `F` already named a picture of its own.
async fn uploading_at_the_merge(pushed: bool) {
    let w = World::new(&["a"]).await;
    let mut want = Vec::new();
    if pushed {
        w.a.seed_picture(F, PICTURE, BTreeMap::from([(w.a.clock.clone(), 1)]));
        w.a.pass().await;
        want.push(PICTURE.to_owned());
    }
    w.server.attachments_down(true);
    want.push(w.a.attach_to_foreign().await);
    want.sort();
    w.b.pass().await;
    w.server.attachments_down(false);
    w.settle().await;
    for (device, mut got) in [("A", w.a.day_pictures()), ("B", w.b.day_pictures())] {
        got.sort();
        assert_eq!(got, want, "{device}'s j<D>");
    }
    let want: Vec<&str> = want.iter().map(String::as_str).collect();
    fresh_device_wants(&w, &want).await;
}

#[tokio::test]
async fn a_picture_uploading_at_the_merge_is_named_under_the_day() {
    uploading_at_the_merge(false).await;
}

#[tokio::test]
async fn a_picture_uploading_at_the_merge_joins_the_carried_ones() {
    uploading_at_the_merge(true).await;
}

/// (#5801) `j<D>`'s note record was deleted: the merge creates it again one
/// tick past the tombstone, naming `F`'s pictures and none of the deleted
/// record's.
#[tokio::test]
async fn a_deleted_day_record_is_created_again_with_the_carried_pictures() {
    let w = World::new(&["a"]).await;
    let clock = BTreeMap::from([(w.a.clock.clone(), 1)]);
    w.a.seed_picture(F, PICTURE, clock.clone());
    w.a.seed_picture(DAY, OWN, clock);
    w.a.pass().await;
    w.a.delete_note(DAY);
    w.a.pass().await;
    w.b.pass().await;
    w.settle().await;
    assert_eq!(w.b.day_pictures(), [PICTURE], "B's j<D>");
    assert_eq!(w.a.day_pictures(), [PICTURE], "A's j<D>");
    fresh_device_wants(&w, &[PICTURE]).await;
}

/// A device that never held `F` pulls the vault and opens `j<D>`; then the
/// three devices settle, so the carry started no push loop.
async fn fresh_device_wants(w: &World, want: &[&str]) {
    let c = Dev::new(&w.server, "c", 23);
    for _ in 0..4 {
        if !c.pass().await {
            break;
        }
    }
    assert!(
        c.db(|conn| Ok(memry_core::domain::journal::journal_exists(conn, DAY))),
        "C pulled the day"
    );
    let mut got = c.day_pictures();
    got.sort();
    assert_eq!(got, want, "C's j<D>");
    w.settle().await;
    assert!(!c.pass().await, "C moved nothing more");
}

#[tokio::test]
async fn a_pushed_tag_the_delete_overwrote_is_kept_day_first() {
    pushed_then_overwritten(Order::DayFirst).await;
}

#[tokio::test]
async fn a_pushed_tag_the_delete_overwrote_is_kept_tombstone_first() {
    pushed_then_overwritten(Order::TombstoneFirst).await;
}

#[tokio::test]
async fn a_tag_removed_after_the_merge_stays_removed_day_first() {
    removed_after_the_merge(Order::DayFirst).await;
}

#[tokio::test]
async fn a_tag_removed_after_the_merge_stays_removed_tombstone_first() {
    removed_after_the_merge(Order::TombstoneFirst).await;
}

const C: &[&str] = &["a", "b", "c"];
const D: &[&str] = &["a", "b", "c", "d"];

#[tokio::test]
async fn an_offline_tag_is_kept_day_first() {
    added_offline(Order::DayFirst, &[C], false).await;
}

#[tokio::test]
async fn an_offline_tag_is_kept_tombstone_first() {
    added_offline(Order::TombstoneFirst, &[C], false).await;
}

#[tokio::test]
async fn an_offline_tag_refused_by_the_delete_is_kept_day_first() {
    added_offline(Order::DayFirst, &[C], true).await;
}

#[tokio::test]
async fn an_offline_tag_refused_by_the_delete_is_kept_tombstone_first() {
    added_offline(Order::TombstoneFirst, &[C], true).await;
}

#[tokio::test]
async fn two_offline_edits_are_kept_day_first() {
    added_offline(Order::DayFirst, &[C, D], false).await;
}

#[tokio::test]
async fn two_offline_edits_are_kept_tombstone_first() {
    added_offline(Order::TombstoneFirst, &[C, D], false).await;
}

#[tokio::test]
async fn offline_text_is_kept_day_first() {
    typed_offline(Order::DayFirst, false).await;
}

#[tokio::test]
async fn offline_text_is_kept_tombstone_first() {
    typed_offline(Order::TombstoneFirst, false).await;
}

#[tokio::test]
async fn text_pushed_while_the_day_merges_is_kept_day_first() {
    typed_offline(Order::DayFirst, true).await;
}

#[tokio::test]
async fn text_pushed_while_the_day_merges_is_kept_tombstone_first() {
    typed_offline(Order::TombstoneFirst, true).await;
}

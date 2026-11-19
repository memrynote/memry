//! A desktop `SyncDriver` over a fake server, for the repairs that run on the
//! driver's pass (`SyncDriver::run_pass`, Step 17 L3b, #3534).
//!
//! Real `AuthSession`, `HttpClient`, sealing, signature checks, SQLite, apply
//! and push. The server answers by route from what it holds: `/sync/pull` the
//! sealed records asked for, `/sync/manifest` its live records, `/sync/push`
//! accepts everything, and `/sync/changes` serves the pages a test queued, then
//! an empty page at the head.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::crypto::agent_envelope::AtRestKey;
use memry_core::crypto::{keys, sodium};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope::{self, RecordMaterial, RecordRequest, SyncOperation};
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::{Db, open_data};
use memry_core::sync::driver::{DriverConfig, DriverParts, SyncDriver};
use memry_core::sync::engine::{MAX_PAGES_PER_PASS, PassReport};
use memry_core::sync::first_sync::FirstSyncLimits;
use memry_core::sync::server_vault;
use memry_core::sync::state::PassTrigger;
use rusqlite::Connection;
use serde_json::{Value as Json, json};

use crate::http_fakes::{FakeSecureStore, body_json, jwt};

const DEVICE: &str = "server-device-1";
pub const PEER: &str = "server-device-2";
/// The seed of [`PEER`]'s signing keypair.
pub const PEER_SEED: u8 = 12;
const MASTER_KEY: [u8; 32] = [7u8; 32];

/// The server: the records it holds, the feed pages queued, every request.
pub struct FakeServer {
    records: Mutex<BTreeMap<String, (String, Json, bool)>>,
    pages: Mutex<VecDeque<String>>,
    calls: Mutex<Vec<HttpRequest>>,
    peer_secret: Vec<u8>,
    /// Purged-tombstone entries by id, served in `purgedTombstones`.
    markers: Mutex<BTreeMap<String, Json>>,
    /// Devices registered after the driver opened: `(id, key seed)`.
    added_devices: Mutex<Vec<(String, u8)>>,
    /// `GET /auth/devices` answers 503 while set.
    devices_down: AtomicBool,
}

impl FakeServer {
    /// Holds `payload` live as the peer's `item_type` record `id`.
    pub fn put(&self, item_type: &str, id: &str, payload: Json) {
        self.seal(item_type, id, payload, None);
    }

    /// Holds `id` deleted, as a peer's delete left it.
    pub fn delete(&self, item_type: &str, id: &str) {
        self.seal(item_type, id, json!({}), Some(1_760_000_000_000));
    }

    /// Queues one feed page listing `ids` (with the types the server holds).
    pub fn page(&self, ids: &[&str], next_cursor: &str) {
        let records = self.records.lock().unwrap();
        let listed: Vec<Json> = ids
            .iter()
            .map(|id| json!({"id": id, "type": records[*id].0}))
            .collect();
        self.pages.lock().unwrap().push_back(
            json!({"items": listed, "deleted": [], "hasMore": false, "nextCursor": next_cursor})
                .to_string(),
        );
    }

    /// Sheds `id`'s payload: `POST /sync/pull` serves `entry` in
    /// `purgedTombstones` for it from now on, never in `items`.
    #[cfg(feature = "markdown")]
    pub fn purge(&self, entry: Json) {
        let id = entry["id"].as_str().expect("an id").to_owned();
        self.records.lock().unwrap().remove(&id);
        self.markers.lock().unwrap().insert(id, entry);
    }

    /// Queues one feed page of `deleted` ids and no refs.
    #[cfg(feature = "markdown")]
    pub fn deleted_page(&self, deleted: &[&str], next_cursor: &str, has_more: bool) {
        self.pages.lock().unwrap().push_back(
            json!({"items": [], "deleted": deleted, "hasMore": has_more,
                    "nextCursor": next_cursor})
            .to_string(),
        );
    }

    /// Registers a device after the driver opened.
    #[cfg(feature = "markdown")]
    pub fn add_device(&self, id: &str, seed: u8) {
        self.added_devices
            .lock()
            .unwrap()
            .push((id.to_owned(), seed));
    }

    /// Fails `GET /auth/devices` until called with `false`.
    #[cfg(feature = "markdown")]
    pub fn devices_down(&self, down: bool) {
        self.devices_down.store(down, Ordering::SeqCst);
    }

    /// The `X-Memry-Sync-Types` of every request to `route`, in order.
    #[cfg(feature = "markdown")]
    pub fn sync_types(&self, route: &str) -> Vec<String> {
        self.calls_to(route)
            .iter()
            .map(|call| {
                call.headers
                    .get("x-memry-sync-types")
                    .cloned()
                    .unwrap_or_default()
            })
            .collect()
    }

    /// How many requests went to `route`.
    #[cfg(feature = "markdown")]
    pub fn count(&self, route: &str) -> usize {
        self.calls_to(route).len()
    }

    /// Stops serving `id` by id, as a pull whose blob went missing; a page queued
    /// before still lists it.
    pub fn withhold(&self, id: &str) {
        self.records.lock().unwrap().remove(id);
    }

    /// Every request URL, in order.
    pub fn urls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.url.clone())
            .collect()
    }

    /// The ids of each `POST /sync/pull`, in order.
    pub fn pulled_ids(&self) -> Vec<Json> {
        self.calls_to("/sync/pull")
            .iter()
            .map(|call| body_json(call)["itemIds"].clone())
            .collect()
    }

    /// Every pushed record as the push sent it.
    pub fn pushed_items(&self) -> Vec<Json> {
        self.calls_to("/sync/push")
            .iter()
            .flat_map(|call| {
                body_json(call)["items"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .collect()
    }

    /// `(type, id, operation)` of every pushed record.
    pub fn pushed(&self) -> Vec<(String, String, String)> {
        self.pushed_items()
            .into_iter()
            .map(|item| {
                let field = |key: &str| item[key].as_str().unwrap_or_default().to_owned();
                (field("type"), field("id"), field("operation"))
            })
            .collect()
    }

    fn calls_to(&self, route: &str) -> Vec<HttpRequest> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| route_of(&call.url) == route)
            .cloned()
            .collect()
    }

    fn seal(&self, item_type: &str, id: &str, payload: Json, deleted_at: Option<i64>) {
        let vault_key = keys::derive_vault_key(&MASTER_KEY).expect("the vault key");
        let content = payload.to_string().into_bytes();
        let sealed = envelope::encrypt(
            &RecordRequest {
                id,
                item_type,
                operation: if deleted_at.is_some() {
                    SyncOperation::Delete
                } else {
                    SyncOperation::Update
                },
                content: &content,
                vault_key: &vault_key,
                signing_secret_key: &self.peer_secret,
                signer_device_id: PEER,
                clock: None,
                state_vector: None,
                deleted_at,
            },
            &RecordMaterial::random(),
        )
        .expect("sealed");
        self.records.lock().unwrap().insert(
            id.to_owned(),
            (
                item_type.to_owned(),
                envelope::to_json(&sealed.envelope),
                deleted_at.is_some(),
            ),
        );
    }

    fn answer(&self, request: &HttpRequest) -> (u16, String) {
        let body = match route_of(&request.url) {
            // No bootstrap window and no packs: a first sync reads the feed.
            "/sync/bootstrap" | "/sync/packs" => return (404, "{}".to_owned()),
            "/auth/devices" => {
                if self.devices_down.load(Ordering::SeqCst) {
                    return (503, "{}".to_owned());
                }
                let public = |seed: u8| {
                    let (public, _) = sodium::sign_seed_keypair(&[seed; 32]).expect("a keypair");
                    BASE64.encode(public)
                };
                let mut devices = vec![
                    json!({"id": DEVICE, "signingPublicKey": public(11)}),
                    json!({"id": PEER, "signingPublicKey": public(PEER_SEED)}),
                ];
                for (id, seed) in self.added_devices.lock().unwrap().iter() {
                    devices.push(json!({"id": id, "signingPublicKey": public(*seed)}));
                }
                json!({ "devices": devices }).to_string()
            }
            "/sync/status" => "{}".to_owned(),
            "/sync/changes" => self.pages.lock().unwrap().pop_front().unwrap_or_else(|| {
                json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": null})
                    .to_string()
            }),
            "/sync/pull" => {
                let records = self.records.lock().unwrap();
                let markers = self.markers.lock().unwrap();
                let asked = body_json(request)["itemIds"].clone();
                let asked: Vec<&str> = asked
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Json::as_str)
                    .collect();
                let items: Vec<Json> = asked
                    .iter()
                    .filter_map(|id| records.get(*id))
                    .map(|(_, sealed, _)| sealed.clone())
                    .collect();
                let purged: Vec<Json> = asked
                    .iter()
                    .filter_map(|id| markers.get(*id).cloned())
                    .collect();
                if purged.is_empty() {
                    json!({ "items": items }).to_string()
                } else {
                    json!({ "items": items, "purgedTombstones": purged }).to_string()
                }
            }
            "/sync/manifest" => {
                let records = self.records.lock().unwrap();
                let items: Vec<Json> = records
                    .iter()
                    .filter(|(_, (_, _, deleted))| !deleted)
                    .map(|(id, (item_type, _, _))| json!({"id": id, "type": item_type}))
                    .collect();
                json!({ "items": items }).to_string()
            }
            "/sync/push" => {
                let ids: Vec<Json> = body_json(request)["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|item| item["id"].clone())
                    .collect();
                json!({"accepted": ids, "rejected": [], "serverTime": 1, "maxCursor": 1})
                    .to_string()
            }
            // CRDT: every update and snapshot is stored, and nothing is held remotely.
            "/sync/crdt/updates" if request.method == "GET" => {
                json!({"updates": [], "hasMore": false}).to_string()
            }
            "/sync/crdt/updates" => {
                let sent = body_json(request)["updates"].as_array().map_or(0, Vec::len);
                json!({ "sequences": (1..=sent).collect::<Vec<_>>() }).to_string()
            }
            "/sync/crdt/snapshot" => json!({"sequenceNum": 1, "revision": "r1"}).to_string(),
            "/sync/crdt/snapshot/batch" => {
                let results: Vec<Json> = body_json(request)["snapshots"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|entry| json!({"noteId": entry["noteId"], "accepted": true, "sequenceNum": 1}))
                    .collect();
                json!({ "results": results }).to_string()
            }
            route if route.starts_with("/sync/crdt/snapshot/") => {
                json!({"snapshot": null}).to_string()
            }
            route => panic!("the fake server has no route {route}"),
        };
        (200, body)
    }
}

/// `https://host/sync/changes?limit=500` -> `/sync/changes`.
fn route_of(url: &str) -> &str {
    let path = url.split_once("://").map_or(url, |(_, rest)| rest);
    let path = &path[path.find('/').unwrap_or(path.len())..];
    path.split('?').next().unwrap_or(path)
}

struct Routes(Arc<FakeServer>);

#[async_trait::async_trait]
impl Transport for Routes {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        self.0.calls.lock().unwrap().push(request.clone());
        let (status, body) = self.0.answer(&request);
        Ok(HttpResponse {
            status,
            headers: HashMap::new(),
            body: body.into_bytes(),
        })
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "the fake server opens no sockets".to_owned(),
        })
    }
}

/// Always online; [`Network::reconnect`] tells the observers it came back.
#[derive(Default)]
pub struct Network(Mutex<Vec<Arc<dyn ReachabilityObserver>>>);

impl Network {
    pub fn reconnect(&self) {
        for observer in self.0.lock().unwrap().iter() {
            observer.on_change(Reachable::Wifi);
        }
    }
}

impl Reachability for Network {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }

    fn observe(&self, observer: Arc<dyn ReachabilityObserver>) {
        self.0.lock().unwrap().push(observer);
    }
}

/// One desktop vault, its driver and the server it syncs with.
pub struct Desktop {
    pub db: Db,
    pub server: Arc<FakeServer>,
    pub network: Arc<Network>,
    pub driver: SyncDriver,
}

impl Desktop {
    /// A driver declaring `types` over a vault `seed` wrote first.
    pub async fn open(
        types: &[&str],
        seed: impl FnOnce(&Connection) -> Result<(), StorageError> + Send + 'static,
    ) -> Self {
        Self::open_with(Declaration::declare(types).expect("recognised"), seed).await
    }

    /// A driver sending `declaration` over a vault `seed` wrote first.
    pub async fn open_with(
        declaration: Declaration,
        seed: impl FnOnce(&Connection) -> Result<(), StorageError> + Send + 'static,
    ) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("memry-driver-")
            .tempdir()
            .expect("the scratch directory")
            .keep();
        let db = open_data(&dir.join("data.db")).expect("open data.db");
        db.call_blocking(move |conn| {
            server_vault::bind(conn, "vault-1")?;
            seed(conn)
        })
        .expect("seed");
        Self::over(db, declaration).await
    }

    /// A driver sending `declaration` over the vault `db` holds, bound to `vault-1`.
    pub async fn over(db: Db, declaration: Declaration) -> Self {
        let (_, peer_secret) = sodium::sign_seed_keypair(&[12u8; 32]).expect("a keypair");
        let server = Arc::new(FakeServer {
            records: Mutex::default(),
            pages: Mutex::default(),
            calls: Mutex::default(),
            peer_secret: peer_secret.to_vec(),
            markers: Mutex::default(),
            added_devices: Mutex::default(),
            devices_down: AtomicBool::new(false),
        });
        Self::drive(db, server, declaration).await
    }

    /// The app restarted: a new driver over the same `data.db` and server.
    #[cfg(feature = "markdown")]
    pub async fn reopen(self, declaration: Declaration) -> Self {
        let Self { db, server, .. } = self;
        Self::drive(db, server, declaration).await
    }

    async fn drive(db: Db, server: Arc<FakeServer>, declaration: Declaration) -> Self {
        let (_, own_secret) = sodium::sign_seed_keypair(&[11u8; 32]).expect("a keypair");
        let store = FakeSecureStore::new();
        store.put_text(
            SecureStoreKey::AccessToken,
            &jwt(
                json!({"sub": "user-1", "device_id": DEVICE, "type": "access",
                        "exp": 9_999_999_999u64}),
            ),
        );
        store
            .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
            .expect("the master key");
        store
            .set(SecureStoreKey::DeviceSigningKey, own_secret.to_vec())
            .expect("the signing key");
        let session = Arc::new(
            AuthSession::new(
                Arc::new(Routes(Arc::clone(&server))),
                store,
                "https://sync.example.com".to_owned(),
                "desktop".to_owned(),
                DeviceDescriptor {
                    name: "Desk".to_owned(),
                    platform: DevicePlatform::Macos,
                    form_factor: None,
                    os_version: None,
                    app_version: "1.0.0".to_owned(),
                    vault_id: None,
                },
                None,
            )
            .expect("a session"),
        );
        let network = Arc::new(Network::default());
        let driver = SyncDriver::open(DriverParts {
            db: db.clone(),
            at_rest: AtRestKey::default(),
            session,
            reachability: network.clone(),
            config: DriverConfig {
                declaration,
                first_sync: FirstSyncLimits::ALL,
                max_pages_per_pass: MAX_PAGES_PER_PASS,
                pack_concurrency: 1,
            },
            seeds: Vec::new(),
            pass_gate: Arc::default(),
        })
        .await
        .expect("the driver");
        Self {
            db,
            server,
            network,
            driver,
        }
    }

    /// One driver pass, which must not fail.
    pub async fn pass(&self) -> PassReport {
        let pass = self
            .driver
            .run_pass(PassTrigger::Timer)
            .await
            .expect("not paused");
        assert!(pass.error().is_none(), "{:?}", pass.error());
        pass
    }
}

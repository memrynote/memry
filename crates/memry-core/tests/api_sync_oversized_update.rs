//! An update past the incremental route's cap goes as a snapshot, through
//! `VaultSync::sync_now` (chapter 07 §7.4.2).
//!
//! The server keeps each update inline in one D1 row, so it refuses an update
//! of more than 1,200,000 base64 characters and the route stalls on it. Before
//! this, the push wave sent such a row anyway: the refusal failed the wave at
//! that batch on every pass and nothing queued behind it was ever sent.
//!
//! Real `HttpClient`, `AuthSession`, SQLite, sealing and snapshot pusher. The
//! transport plays the server: routes by path, refuses a long update, and
//! records the bodies it was sent.

mod http_fakes;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::TransportError;
use memry_core::api::vault::Vault;
use memry_core::crdt::{BODY_FRAGMENT, update_log};
use memry_core::crypto::{keys, sodium};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::crdt_envelope::{MAX_UPDATE_PAYLOAD_CHARS, unpack};
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::Db;
use memry_core::sync::outbox::{self, Change};
use serde_json::{Value as Json, json};
use yrs::updates::decoder::Decode as _;
use yrs::{
    Doc, GetString as _, ReadTxn as _, StateVector, Transact as _, Update, XmlFragment as _,
    XmlTextPrelim,
};

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
const DEVICE_ID: &str = "server-device-1";

/// What the server was asked, and how it answers the snapshot route.
struct Server {
    calls: Mutex<Vec<(String, Json)>>,
    snapshot_status: u16,
    /// Every changes page says there is another, so the pass stops at its page cap.
    endless_changes: bool,
}

impl Server {
    fn new(snapshot_status: u16) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            snapshot_status,
            endless_changes: false,
        })
    }

    fn endless() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            snapshot_status: 200,
            endless_changes: true,
        })
    }

    fn bodies(&self, path_suffix: &str) -> Vec<Json> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(url, _)| url.ends_with(path_suffix))
            .map(|(_, body)| body.clone())
            .collect()
    }
}

#[async_trait::async_trait]
impl Transport for Server {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let body: Json = request.body.as_deref().map_or(Json::Null, |bytes| {
            serde_json::from_slice(bytes).unwrap_or(Json::Null)
        });
        self.calls
            .lock()
            .unwrap()
            .push((request.url.clone(), body.clone()));
        let path = request.url.strip_prefix(BASE).unwrap_or(&request.url);
        let (public, _) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
        match path.split('?').next().unwrap_or(path) {
            "/auth/devices" => response(
                200,
                &json!({"devices": [{"id": DEVICE_ID, "signingPublicKey": BASE64.encode(&public)}]})
                    .to_string(),
            ),
            "/sync/changes" => {
                let calls = self.calls.lock().unwrap().len();
                response(
                    200,
                    &json!({"items": [], "deleted": [], "hasMore": self.endless_changes, "nextCursor": calls, "noteBodies": []})
                        .to_string(),
                )
            }
            "/sync/crdt/updates" if request.method == "GET" => {
                response(200, &json!({"updates": [], "hasMore": false}).to_string())
            }
            "/sync/crdt/updates" => {
                let updates = body["updates"].as_array().cloned().unwrap_or_default();
                if updates.iter().any(|u| u.as_str().is_some_and(|s| s.len() > MAX_UPDATE_PAYLOAD_CHARS)) {
                    return response(413, "{}");
                }
                let sequences: Vec<usize> = (1..=updates.len()).collect();
                response(200, &json!({ "sequences": sequences }).to_string())
            }
            "/sync/crdt/snapshot" if self.snapshot_status == 200 => {
                response(200, &json!({"sequenceNum": 1, "revision": "r1"}).to_string())
            }
            "/sync/crdt/snapshot" => response(self.snapshot_status, "{}"),
            other if other.starts_with("/sync/crdt/snapshot/") => {
                response(200, &json!({"snapshot": null}).to_string())
            }
            other => panic!("unscripted request to {other}"),
        }
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets here".to_string(),
        })
    }
}

fn vault_with_side(label: &str, server: Arc<Server>) -> (Vault, Db, Arc<AuthSession>) {
    let (_public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": DEVICE_ID, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("signing key");
    let dir: PathBuf = tempfile::Builder::new()
        .prefix(&format!("memry-oversized-update-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let side = memry_core::storage::open_data(&dir.join("data.db")).expect("a second handle");
    let session = Arc::new(
        AuthSession::new(
            server,
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );
    (vault, side, session)
}

/// `chars` printable characters a deflate cannot do much with, so the packed
/// update is about as long as the text.
fn noisy_text(chars: usize, marker: &str) -> String {
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut text: String = (0..chars)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            char::from(b' ' + ((state >> 33) % 95) as u8)
        })
        .collect();
    text.push_str(marker);
    text
}

/// One body update of `doc_id` carrying `text`, as the local edit path writes
/// it: the update log row and the outbox row commit together.
fn queue_body_update(side: &Db, doc_id: &str, text: &str) {
    let author = Doc::with_client_id(1);
    let fragment = author.get_or_insert_xml_fragment(BODY_FRAGMENT);
    fragment.push_back(&mut author.transact_mut(), XmlTextPrelim::new(text));
    let update = author
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let doc_id = doc_id.to_owned();
    side.call_blocking(move |conn| {
        outbox::commit(
            conn,
            &Change::crdt_update("note", &doc_id, update.clone()),
            1,
            |tx| {
                update_log::append_local_update_in(tx, &doc_id, &update, 1).map_err(|error| {
                    memry_core::api::errors::StorageError::Failed {
                        what: error.to_string(),
                    }
                })
            },
        )?;
        Ok(())
    })
    .expect("queue the update");
}

fn queued(side: &Db) -> Vec<(String, Option<String>)> {
    side.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT item_id, last_error FROM outbox ORDER BY id")
            .map_err(|e| memry_core::api::errors::StorageError::Failed {
                what: e.to_string(),
            })?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| memry_core::api::errors::StorageError::Failed {
                what: e.to_string(),
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| memry_core::api::errors::StorageError::Failed {
                what: e.to_string(),
            })?;
        Ok(rows)
    })
    .expect("read the outbox")
}

#[tokio::test]
async fn an_oversized_update_goes_as_a_snapshot_that_holds_the_whole_batch() {
    let server = Server::new(200);
    let (vault, side, session) = vault_with_side("snapshot", server.clone());
    queue_body_update(&side, "bigdoc000001", "small edit before");
    queue_body_update(&side, "bigdoc000001", &noisy_text(1_500_000, "BIG EDIT"));
    // The queue behind it: another document's small update.
    queue_body_update(&side, "smalldoc0001", "behind the large one");

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert_eq!(summary.pending, 0, "{summary:?} {:?}", queued(&side));
    let snapshots = server.bodies("/sync/crdt/snapshot");
    assert_eq!(snapshots.len(), 1, "one snapshot for the document");
    assert_eq!(snapshots[0]["noteId"], json!("bigdoc000001"));
    let incremental: Vec<Json> = server.bodies("/sync/crdt/updates");
    assert_eq!(
        incremental.len(),
        1,
        "only the other document rides updates"
    );
    assert_eq!(incremental[0]["noteId"], json!("smalldoc0001"));

    // The snapshot holds both of the batch's updates, not only the large one.
    let (public, _) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let vault_key = keys::derive_vault_key(&MASTER_KEY).expect("the vault key");
    let packed = BASE64
        .decode(snapshots[0]["snapshot"].as_str().expect("a snapshot"))
        .expect("base64");
    let state = unpack(&packed, "bigdoc000001", &vault_key, &public).expect("opens");
    let replay = Doc::new();
    let fragment = replay.get_or_insert_xml_fragment(BODY_FRAGMENT);
    replay
        .transact_mut()
        .apply_update(Update::decode_v1(&state).expect("a state"))
        .expect("applies");
    let text = fragment.get_string(&replay.transact());
    assert!(
        text.contains("small edit before") && text.contains("BIG EDIT"),
        "{}",
        text.len()
    );
}

#[tokio::test]
async fn a_refused_snapshot_defers_the_batch_and_the_queue_behind_it_still_drains() {
    let server = Server::new(500);
    let (vault, side, session) = vault_with_side("refused", server.clone());
    queue_body_update(&side, "bigdoc000001", &noisy_text(1_500_000, "BIG EDIT"));
    queue_body_update(&side, "smalldoc0001", "behind the large one");

    let summary = vault
        .sync(session)
        .sync_now()
        .await
        .expect("the pass completes");

    assert_eq!(summary.rejected, 1, "{summary:?}");
    assert_eq!(
        summary.pending, 1,
        "the large update stays queued: {summary:?}"
    );
    let left = queued(&side);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].0, "bigdoc000001");
    assert!(left[0].1.is_some(), "the reason is recorded on the row");
    assert!(
        server
            .bodies("/sync/crdt/updates")
            .iter()
            .all(|b| b["noteId"] == json!("smalldoc0001"))
    );
}

#[tokio::test]
async fn a_pull_that_stopped_at_its_page_cap_keeps_the_snapshot_gate_closed() {
    // A snapshot prunes the server's updates below its watermark, so it must
    // not go while the pull has not reached the head.
    let server = Server::endless();
    let (vault, side, session) = vault_with_side("page-cap", server.clone());
    queue_body_update(&side, "bigdoc000001", &noisy_text(1_500_000, "BIG EDIT"));

    let summary = vault
        .sync(session)
        .sync_now()
        .await
        .expect("the pass completes");

    assert!(
        server.bodies("/sync/crdt/snapshot").is_empty(),
        "no snapshot was sent"
    );
    assert_eq!(summary.pending, 1, "{summary:?}");
    assert_eq!(
        queued(&side)[0].1.as_deref(),
        Some("the document still holds unmerged remote state")
    );
}

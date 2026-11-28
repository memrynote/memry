//! REVIEW-5139 finding 1: an imported vault's unclocked rows reach the server only through the
//! core pass's seed, after a pull that reached the feed head, as Electron's full sync runs pull,
//! `seedUnclocked`, push (`full-sync-runner.ts`). A version another device pushed first lands on
//! the unclocked row and wins (`resolveUpsertClock(null, remote)`). Over the installed vault and
//! the core's `PullLoop` and `SyncEngine` against a scripted server, with the seeds the sync
//! driver registers (`TagSeed`'s `tag_mint::seed`, then `UnclockedSeed`).
//!
//! | Test                                                     | Rule                                |
//! | -------------------------------------------------------- | ----------------------------------- |
//! | a server folder and definition win over imported ones    | nothing pushed from the import      |
//! | server "work" wins over an imported unclocked "Work"     | the tag seed matches without case   |
//! | the seed runs once, after a pull that reached the head   | no seed while the feed has more     |

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{ApiError, StorageError, TransportError};
use memry_core::domain::tag_mint;
use memry_core::domain::unclocked_seed::UnclockedSeed;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::import::DATA_FILE;
use memry_core::storage::{Db, open_data};
use memry_core::sync::engine::{PassSeed, PushWave, SyncEngine};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::state::PassTrigger;
use rusqlite::types::Value as Sql;
use serde_json::{Value, json};

use super::queue::text;
use super::{NOW_MS, Vault, electron_db, import};

const CORE_DEVICE: &str = "device-core";
const CREATED: &str = "2026-01-02T03:04:05.000Z";

/// The server: the records the next pass's pull serves, and whether its feed has more.
#[derive(Default)]
struct Server {
    next: Mutex<Vec<(String, String, Value)>>,
    plain: Mutex<HashMap<String, Vec<u8>>>,
    has_more: AtomicBool,
}

fn reply(body: &Value) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: body.to_string().into_bytes(),
    })
}

#[async_trait::async_trait]
impl Transport for Server {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        if request.url.contains("/sync/status") {
            return reply(&json!({"clientPolicy": {"writesEnabled": true}}));
        }
        if request.url.contains("/sync/changes") {
            let items: Vec<Value> = self
                .next
                .lock()
                .unwrap()
                .iter()
                .map(|(item_type, id, _)| json!({"id": id, "type": item_type}))
                .collect();
            return reply(&json!({
                "items": items, "deleted": [], "nextCursor": "9",
                "hasMore": self.has_more.load(Ordering::SeqCst),
            }));
        }
        if request.url.contains("/sync/pull") {
            let served = std::mem::take(&mut *self.next.lock().unwrap());
            let mut plain = self.plain.lock().unwrap();
            let items: Vec<Value> = served
                .into_iter()
                .map(|(item_type, id, payload)| {
                    plain.insert(id.clone(), payload.to_string().into_bytes());
                    json!({
                        "id": id, "type": item_type, "operation": "update",
                        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
                        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "device-b",
                        "clock": payload["clock"], "serverCursor": 7,
                    })
                })
                .collect();
            return reply(&json!({ "items": items }));
        }
        panic!("unscripted request to {}", request.url)
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets".into(),
        })
    }
}

struct Cipher(Arc<Server>);

impl RecordCipher for Cipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(self.0.plain.lock().unwrap()[&envelope.id].clone())
    }
}

struct Online;

impl Reachability for Online {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}

/// Records `(type, id, op)` of every outbox row when the push drains it, then empties it, as an
/// acknowledged wave does.
struct Push {
    db: Db,
    pushed: Arc<Mutex<Vec<(String, String, String)>>>,
}

#[async_trait::async_trait]
impl PushWave for Push {
    async fn pending(&self) -> Result<usize, ApiError> {
        let rows = self.db.read(outbox).await.unwrap();
        Ok(rows.len())
    }

    async fn drain(&self) -> Result<usize, ApiError> {
        let rows = self
            .db
            .call(|conn| {
                let rows = outbox(conn)?;
                conn.execute("DELETE FROM outbox", []).map_err(failed)?;
                Ok(rows)
            })
            .await
            .unwrap();
        let accepted = rows.len();
        self.pushed.lock().unwrap().extend(rows);
        Ok(accepted)
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn outbox(conn: &rusqlite::Connection) -> Result<Vec<(String, String, String)>, StorageError> {
    let mut statement = conn
        .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY item_type, item_id")
        .map_err(failed)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// `TagSeed`'s body: its hub needs a session this test has no use for.
struct TagMintSeed(Db);

#[async_trait::async_trait]
impl PassSeed for TagMintSeed {
    async fn seed(&self) -> Result<(), StorageError> {
        self.0
            .call(|conn| tag_mint::seed(conn, CORE_DEVICE, NOW_MS))
            .await?;
        Ok(())
    }
}

/// The installed vault under a sync engine with the driver's seeds, one page a pass.
struct Synced {
    db: Db,
    server: Arc<Server>,
    engine: SyncEngine,
    pushed: Arc<Mutex<Vec<(String, String, String)>>>,
    runtime: tokio::runtime::Runtime,
}

impl Synced {
    fn over(vault: &Vault) -> Self {
        let db = open_data(&vault.core().join(DATA_FILE)).unwrap();
        let server = Arc::new(Server::default());
        let http = Arc::new(HttpClient::new(
            server.clone(),
            "https://sync.example",
            ClientIdentity::new("desktop", "1.2.3").unwrap(),
        ));
        let pull = Arc::new(PullLoop::new(
            http.clone(),
            db.clone(),
            Declaration::subscribed(),
            Arc::new(Cipher(server.clone())),
        ));
        let pushed = Arc::new(Mutex::new(Vec::new()));
        let engine = SyncEngine::new(pull, http, Arc::new(Online))
            .with_push(Arc::new(Push {
                db: db.clone(),
                pushed: pushed.clone(),
            }))
            .with_max_pages(1)
            .with_seed(Arc::new(TagMintSeed(db.clone())))
            .with_seed(Arc::new(UnclockedSeed::new(
                db.clone(),
                CORE_DEVICE.to_owned(),
            )));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        Self {
            db,
            server,
            engine,
            pushed,
            runtime,
        }
    }

    /// One pass; the `(type, id, op)` rows it pushed, sorted.
    fn pass(&self) -> Vec<(String, String, String)> {
        let report = self
            .runtime
            .block_on(self.engine.run_pass(PassTrigger::Explicit));
        assert!(report.error().is_none(), "{:?}", report.error());
        std::mem::take(&mut *self.pushed.lock().unwrap())
    }

    fn serve(&self, item_type: &str, id: &str, payload: Value) {
        self.server
            .next
            .lock()
            .unwrap()
            .push((item_type.to_owned(), id.to_owned(), payload));
    }

    /// `(payload, clock)` of the record, deleted or not.
    fn record(&self, item_type: &str, id: &str) -> Option<(Value, Option<String>)> {
        let (item_type, id) = (item_type.to_owned(), id.to_owned());
        self.db
            .read_blocking(move |conn| {
                use rusqlite::OptionalExtension;
                conn.query_row(
                    "SELECT payload, clock FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                    [&item_type, &id],
                    |row| Ok((row.get::<_, String>(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(failed)
            })
            .unwrap()
            .map(|(payload, clock)| (serde_json::from_str(&payload).unwrap(), clock))
    }
}

fn pushed(rows: &[(&str, &str, &str)]) -> Vec<(String, String, String)> {
    rows.iter()
        .map(|(a, b, c)| ((*a).to_owned(), (*b).to_owned(), (*c).to_owned()))
        .collect()
}

fn seed_folder(vault: &Vault, path: &str) {
    electron_db::seed(
        &vault.data_conn(),
        "folder_configs",
        &[
            ("path", text(path)),
            ("icon", text("star")),
            ("created_at", text(CREATED)),
            ("modified_at", text(CREATED)),
        ],
    );
}

fn seed_property(vault: &Vault, name: &str) {
    electron_db::seed(
        &vault.data_conn(),
        "property_definitions",
        &[
            ("name", text(name)),
            ("type", text("select")),
            ("options", text(r#"["a","b"]"#)),
            ("created_at", text(CREATED)),
        ],
    );
}

fn seed_tag(vault: &Vault, name: &str) {
    electron_db::seed(
        &vault.data_conn(),
        "tag_definitions",
        &[
            ("name", text(name)),
            ("color", text("rose")),
            ("clock", Sql::Null),
            ("created_at", text(CREATED)),
        ],
    );
}

/// Device B set the folder's icon and the definition's options after this vault last synced.
/// Electron pulls them onto its unclocked rows and seeds nothing; the import queued nothing to
/// overwrite them everywhere.
#[test]
fn a_server_folder_and_definition_win_over_the_imported_unclocked_ones() {
    let vault = Vault::new();
    seed_folder(&vault, "Projects");
    seed_property(&vault, "mood");
    import(&vault);
    let s = Synced::over(&vault);

    let mut folder = s.record("folder_config", "Projects").unwrap().0;
    folder["icon"] = json!("moon");
    folder["clock"] = json!({"device-b": 2});
    let mut definition = s.record("property_definition", "mood").unwrap().0;
    definition["options"] = json!(r#"["x"]"#);
    definition["clock"] = json!({"device-b": 2});
    s.serve("folder_config", "Projects", folder);
    s.serve("property_definition", "mood", definition);

    assert_eq!(s.pass(), pushed(&[]));
    let (folder, clock) = s.record("folder_config", "Projects").unwrap();
    assert_eq!(
        (folder["icon"].clone(), clock.as_deref()),
        (json!("moon"), Some(r#"{"device-b":2}"#))
    );
    let (definition, clock) = s.record("property_definition", "mood").unwrap();
    assert_eq!(
        (definition["options"].clone(), clock.as_deref()),
        (json!(r#"["x"]"#), Some(r#"{"device-b":2}"#))
    );
    assert_eq!(s.pass(), pushed(&[]));
}

/// The imported vault named the tag "Work" and never synced it; device B pushed "work". Electron
/// applies "work" into its NOCASE row and sends nothing; so does the core's tag seed, which owns
/// the imported unclocked definitions as it owns its own mints.
#[test]
fn a_server_tag_of_another_case_wins_over_an_imported_unclocked_one() {
    let vault = Vault::new();
    seed_tag(&vault, "Work");
    import(&vault);
    let s = Synced::over(&vault);
    s.serve(
        "tag_definition",
        "work",
        json!({
            "name": "work", "color": "teal", "colorAuthored": true, "clock": {"device-b": 2},
            "createdAt": CREATED,
        }),
    );

    assert_eq!(s.pass(), pushed(&[]));
    assert!(s.record("tag_definition", "Work").is_none());
    assert!(s.record("tag_definition", "work").is_some());
    assert_eq!(s.pass(), pushed(&[]));
}

/// A pass whose pull stopped short of the feed head seeds nothing; the first that reaches it
/// gives every imported unclocked row its clock under the core device and pushes its create;
/// later passes push nothing again.
#[test]
fn the_seed_runs_once_after_a_pull_that_reached_the_head() {
    let vault = Vault::new();
    seed_folder(&vault, "Fresh");
    seed_property(&vault, "mood");
    seed_tag(&vault, "home");
    import(&vault);
    let s = Synced::over(&vault);

    s.server.has_more.store(true, Ordering::SeqCst);
    assert_eq!(s.pass(), pushed(&[]), "the feed has more");
    assert_eq!(s.record("folder_config", "Fresh").unwrap().1, None);

    s.server.has_more.store(false, Ordering::SeqCst);
    assert_eq!(
        s.pass(),
        pushed(&[
            ("folder_config", "Fresh", "create"),
            ("property_definition", "mood", "create"),
            ("tag_definition", "home", "create"),
        ])
    );
    let first = Some(r#"{"device-core":1}"#);
    assert_eq!(
        s.record("folder_config", "Fresh").unwrap().1.as_deref(),
        first
    );
    assert_eq!(
        s.record("tag_definition", "home").unwrap().1.as_deref(),
        first
    );
    assert_eq!(s.pass(), pushed(&[]), "seeded once");
}

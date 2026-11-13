//! What sync makes of the definitions the note index mints (#4418): a mint stays on this device,
//! unclocked and unqueued, until a sync pass whose pull reached the feed head seeds it, as
//! Electron's full sync runs pull, `seedUnclocked`, push. Over a real session, tier, watcher and
//! index task, and the core's `PullLoop` and `SyncEngine` against a scripted server; the push
//! records what the outbox holds when it drains.
//!
//! | Test                                                     | Rule                                   |
//! | -------------------------------------------------------- | -------------------------------------- |
//! | a remote spelling that lands after the mint wins         | the seed checks every record by key    |
//! | a pulled delete stays deleted while a file carries the tag | never mint over a tombstone          |
//! | a fresh tag is pushed once, after the pull               | `seedUnclocked` between pull and push  |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use index_support::until;
use memry_core::api::errors::{ApiError, TransportError};
use memry_core::api::tag_hub::TagSeed;
use memry_core::domain::tag_admin::{Definition, definitions};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::SecureStore;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::Db;
use memry_core::sync::engine::{PushWave, SyncEngine};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::state::PassTrigger;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use serde_json::{Value, json};
use vault_env::{Env, env, indexed};

/// The server: the next pass's feed page, then an empty feed.
#[derive(Default)]
struct Server {
    /// Records `(envelope, plaintext)` the next pull serves.
    next: Mutex<Vec<(Value, Value)>>,
    /// Plaintext by item id, for the cipher.
    plain: Mutex<HashMap<String, Vec<u8>>>,
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
            let next = self.next.lock().unwrap();
            let items: Vec<Value> = next
                .iter()
                .map(|(envelope, _)| json!({"id": envelope["id"], "type": "tag_definition"}))
                .collect();
            return reply(&json!({
                "items": items, "deleted": [], "hasMore": false, "nextCursor": "9",
            }));
        }
        if request.url.contains("/sync/pull") {
            let served: Vec<(Value, Value)> = std::mem::take(&mut *self.next.lock().unwrap());
            let mut plain = self.plain.lock().unwrap();
            let items: Vec<Value> = served
                .into_iter()
                .map(|(envelope, payload)| {
                    let id = envelope["id"].as_str().unwrap().to_owned();
                    plain.insert(id, payload.to_string().into_bytes());
                    envelope
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

/// Records the `tag_definition` ids the outbox holds when the push drains it, then empties it,
/// as an acknowledged wave does.
struct Push {
    db: Db,
    pushed: Arc<Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl PushWave for Push {
    async fn pending(&self) -> Result<usize, ApiError> {
        let count = self
            .db
            .read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .await
            .unwrap();
        Ok(usize::try_from(count).unwrap())
    }

    async fn drain(&self) -> Result<(), ApiError> {
        let ids = self
            .db
            .call(|conn| {
                let mut statement = conn
                    .prepare(
                        "SELECT item_id FROM outbox WHERE item_type = 'tag_definition' ORDER BY id",
                    )
                    .unwrap();
                let ids: Vec<String> = statement
                    .query_map([], |row| row.get(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                conn.execute("DELETE FROM outbox", []).unwrap();
                Ok(ids)
            })
            .await
            .unwrap();
        self.pushed.lock().unwrap().extend(ids);
        Ok(())
    }
}

/// An open vault with the index registered, and a sync engine over it with the tag seed.
struct Synced {
    e: Env,
    server: Arc<Server>,
    engine: SyncEngine,
    pushed: Arc<Mutex<Vec<String>>>,
    runtime: tokio::runtime::Runtime,
}

impl Synced {
    fn open(files: &[(&str, &str)]) -> Self {
        let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
        let mut e = env(|s| {
            *store.lock().unwrap() = Some(s.clone());
            Some(NotesIdentity::new(s))
        });
        for (rel, text) in files {
            e.write(rel, text);
        }
        NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
        e.open();
        e.facts_until(indexed);
        until("every file read", || index_support::all_indexed(&e));
        let store = store.into_inner().unwrap().unwrap();
        let server = Arc::new(Server::default());
        let db = e.core().db_handle();
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
        let hub = Arc::new(e.core().tag_hub(store).unwrap());
        let engine = SyncEngine::new(pull, http, Arc::new(Online))
            .with_push(Arc::new(Push {
                db,
                pushed: pushed.clone(),
            }))
            .with_seed(Arc::new(TagSeed(hub)));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        Self {
            e,
            server,
            engine,
            pushed,
            runtime,
        }
    }

    /// One pass; the `tag_definition` ids it pushed.
    fn pass(&self) -> Vec<String> {
        self.runtime
            .block_on(self.engine.run_pass(PassTrigger::Explicit));
        std::mem::take(&mut *self.pushed.lock().unwrap())
    }

    fn serve(&self, envelope: Value, payload: Value) {
        self.server.next.lock().unwrap().push((envelope, payload));
    }

    fn definitions(&self) -> Vec<Definition> {
        self.e
            .core()
            .db_handle()
            .read_blocking(definitions)
            .unwrap()
            .into_values()
            .collect()
    }

    fn defined(&self, key: &str) -> Option<Definition> {
        self.e
            .core()
            .db_handle()
            .read_blocking(definitions)
            .unwrap()
            .remove(key)
    }

    /// Every `tag_definition` record's id, and the ones the outbox holds.
    fn records(&self) -> (Vec<String>, Vec<String>) {
        self.e
            .core()
            .db_handle()
            .read_blocking(|conn| {
                let ids = |sql: &str| -> Vec<String> {
                    let mut statement = conn.prepare(sql).unwrap();
                    statement
                        .query_map([], |row| row.get(0))
                        .unwrap()
                        .collect::<Result<_, _>>()
                        .unwrap()
                };
                Ok((
                    ids(
                        "SELECT item_id FROM sync_items WHERE item_type = 'tag_definition'
                          ORDER BY item_id",
                    ),
                    ids("SELECT item_id FROM outbox WHERE item_type = 'tag_definition'"),
                ))
            })
            .unwrap()
    }

    fn payload(&self, id: &str) -> Value {
        let id = id.to_owned();
        self.e
            .core()
            .db_handle()
            .read_blocking(move |conn| {
                let raw: String = conn
                    .query_row(
                        "SELECT payload FROM sync_items WHERE item_type = 'tag_definition'
                          AND item_id = ?1",
                        [&id],
                        |row| row.get(0),
                    )
                    .unwrap();
                Ok(serde_json::from_str(&raw).unwrap())
            })
            .unwrap()
    }
}

fn envelope(id: &str, deleted_at: Option<i64>) -> Value {
    let mut envelope = json!({
        "id": id, "type": "tag_definition", "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "device-b",
        "clock": {"device-b": 2}, "serverCursor": 7,
    });
    if let Some(at) = deleted_at {
        envelope["deletedAt"] = json!(at);
        envelope["operation"] = json!("delete");
    }
    envelope
}

/// Device B named the tag `Work` and gave it a colour, an icon and a category; this device's
/// index minted `work` from a note before it pulled. The pull brings B's; the seed keeps it as
/// the tag's one item and pushes nothing for `work`.
#[test]
fn a_remote_spelling_that_lands_after_the_mint_wins() {
    let s = Synced::open(&[("a.md", "---\ntags: [work]\n---\n")]);
    until("work minted", || s.defined("work").is_some());
    assert_eq!(
        s.records(),
        (vec!["work".to_owned()], vec![]),
        "minted, not queued"
    );

    s.serve(
        envelope("Work", None),
        json!({
            "name": "Work", "color": "teal", "colorAuthored": true, "icon": "icon:Star",
            "categoryId": "cat-1", "sortOrder": 3, "clock": {"device-b": 2},
            "createdAt": "2026-01-01T00:00:00.000Z",
        }),
    );
    let pushed = s.pass();
    assert!(
        !pushed.iter().any(|id| id.eq_ignore_ascii_case("work")),
        "{pushed:?}"
    );
    assert_eq!(s.records(), (vec!["Work".to_owned()], vec![]));
    let defined = s.definitions();
    assert_eq!(defined.len(), 1, "{defined:?}");
    let work = &defined[0];
    assert_eq!(work.id, "Work");
    assert_eq!(work.color, "teal");
    assert_eq!(work.icon.as_deref(), Some("icon:Star"));
    assert_eq!(work.category_id.as_deref(), Some("cat-1"));
    assert!(s.pass().is_empty(), "nothing on a later pass");
}

/// Device B deleted `x`. This device pulls the delete, then reads a note that still carries
/// `x`: `x` stays deleted and is never pushed; the note's new tag is.
#[test]
fn a_pulled_delete_stays_deleted_while_a_file_carries_the_tag() {
    let s = Synced::open(&[]);
    s.serve(envelope("x", Some(1_700_000_000_000)), json!({}));
    assert!(s.pass().is_empty());

    s.e.write("a.md", "---\ntags: [x, y]\n---\n");
    until("y minted", || s.defined("y").is_some());
    assert!(s.defined("x").is_none(), "x came back");
    assert_eq!(s.pass(), ["y"]);
    assert!(s.defined("x").is_none(), "x came back after the pass");
    assert_eq!(s.records().1, Vec::<String>::new());
}

/// A tag no device defined is minted on this device, then pushed once by the first pass, after
/// its pull, as Electron's seed pushes it: a `create` with a clock and an unauthored colour.
#[test]
fn a_fresh_tag_is_pushed_once_after_the_pull() {
    let s = Synced::open(&[("a.md", "---\ntags: [fresh]\n---\n")]);
    until("fresh minted", || s.defined("fresh").is_some());
    assert_eq!(
        s.records(),
        (vec!["fresh".to_owned()], vec![]),
        "minted, not queued"
    );
    assert!(
        s.payload("fresh").get("clock").is_none(),
        "unclocked until seeded"
    );

    assert_eq!(s.pass(), ["fresh"]);
    let payload = s.payload("fresh");
    assert_eq!(payload["colorAuthored"], Value::Bool(false));
    assert_eq!(payload["color"], "rose");
    assert!(payload["clock"].is_object(), "{payload}");
    assert!(s.pass().is_empty(), "pushed once");
}

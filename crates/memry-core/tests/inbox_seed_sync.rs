//! iOS's pass seeds the Inbox as desktop's driver does (#3538): `VaultSync::sync_now` clocks and
//! queues the unclocked Inbox `Tasks::ensure_inbox` wrote, and only after a pull that reached the
//! feed head, so an Inbox another device pushed first replaces it. Real `AuthSession`,
//! `HttpClient`, sealing, SQLite, apply and push; the server is the route-answering fake.

use std::sync::Arc;

use memry_core::api::auth::AuthSession;
use memry_core::api::vault::Vault;
use rusqlite::Connection;
use serde_json::{Value as Json, json};
use tempfile::TempDir;

use crate::driver_fakes::{FakeServer, session_on};

/// `sync_now`'s page ceiling (`MAX_PULL_PAGES`, `api/sync/pass.rs`).
const PASS_PAGES: usize = 200;

/// A fresh phone vault holding the unclocked Inbox `ensure_inbox` wrote.
struct Phone {
    vault: Vault,
    data: Connection,
    server: Arc<FakeServer>,
    session: Arc<AuthSession>,
    // Last, so the database closes before its directory goes.
    _dir: TempDir,
}

fn phone() -> Phone {
    let dir = tempfile::Builder::new()
        .prefix("memry-inbox-seed-")
        .tempdir()
        .expect("the scratch directory");
    let vault = Vault::open("vault-1".to_owned(), dir.path().display().to_string()).expect("open");
    let server = FakeServer::new();
    let (session, store) = session_on(&server);
    let tasks = vault.tasks(store).expect("the task surface");
    assert!(tasks.ensure_inbox().expect("the seed"), "a fresh vault");
    let data = Connection::open(dir.path().join("data.db")).expect("a connection of its own");
    Phone {
        vault,
        data,
        server,
        session,
        _dir: dir,
    }
}

impl Phone {
    async fn pass(&self) {
        self.vault
            .sync(self.session.clone())
            .sync_now()
            .await
            .expect("the pass");
    }

    fn inbox(&self) -> (Option<String>, Json) {
        let (clock, payload): (Option<String>, String) = self
            .data
            .query_row(
                "SELECT clock, payload FROM sync_items
                 WHERE item_type = 'project' AND item_id = 'inbox'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the inbox");
        (clock, serde_json::from_str(&payload).expect("json"))
    }

    fn queued(&self) -> i64 {
        self.data
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_type = 'project' AND item_id = 'inbox'",
                [],
                |row| row.get(0),
            )
            .expect("count")
    }

    fn inbox_pushes(&self) -> Vec<String> {
        self.server
            .pushed()
            .into_iter()
            .filter(|(item_type, id, _)| item_type == "project" && id == "inbox")
            .map(|(_, _, operation)| operation)
            .collect()
    }
}

#[tokio::test]
async fn a_pass_that_reaches_the_head_clocks_and_pushes_the_inbox_once() {
    let phone = phone();
    assert_eq!(phone.inbox().0, None, "ensure_inbox writes no clock");

    phone.pass().await;
    assert_eq!(phone.inbox_pushes(), ["create"]);
    assert_eq!(phone.queued(), 0);
    assert!(phone.inbox().0.is_some(), "the seed clocked it");

    phone.pass().await;
    assert_eq!(phone.inbox_pushes(), ["create"], "seeded once");
}

#[tokio::test]
async fn a_pass_short_of_the_head_seeds_nothing() {
    let phone = phone();
    for page in 0..PASS_PAGES {
        phone
            .server
            .deleted_page(&[], &format!("cursor-{page}"), true);
    }

    phone.pass().await;
    assert!(phone.inbox_pushes().is_empty());
    assert_eq!((phone.inbox().0, phone.queued()), (None, 0));

    // The next pass reaches the head, and seeds.
    phone.pass().await;
    assert_eq!(phone.inbox_pushes(), ["create"]);
}

fn status(id: &str, name: &str, position: i64, default: bool, done: bool) -> Json {
    json!({"id": id, "projectId": "inbox", "name": name, "color": "#6b7280", "position": position,
           "isDefault": default, "isDone": done, "createdAt": "2025-01-01T00:00:00.000Z"})
}

#[tokio::test]
async fn an_inbox_another_device_pushed_first_replaces_the_seed() {
    let phone = phone();
    let clock = json!({"electron-device": 4});
    phone.server.put(
        "project",
        "inbox",
        json!({
            "name": "Capture", "color": "#6366f1", "icon": "📥", "position": 0, "isInbox": true,
            "statuses": [
                status("inbox-todo", "Backlog", 0, true, false),
                status("inbox-in-progress", "In Progress", 1, false, false),
                status("inbox-review", "Review", 2, false, false),
                status("inbox-done", "Done", 3, false, true),
            ],
            "clock": clock,
            "fieldClocks": {"name": clock, "color": clock, "icon": clock, "position": clock,
                            "isInbox": clock},
            "createdAt": "2025-01-01T00:00:00.000Z", "modifiedAt": "2025-01-02T00:00:00.000Z"
        }),
    );
    phone.server.page(&["inbox"], "1");

    phone.pass().await;
    let (_, payload) = phone.inbox();
    assert_eq!(payload["name"], "Capture");
    assert_eq!(payload["statuses"].as_array().map(Vec::len), Some(4));
    assert_eq!(payload["clock"], clock, "the peer's clock, not a seed's");
    assert!(phone.inbox_pushes().is_empty());
    assert_eq!(phone.queued(), 0);
}

//! The Inbox every vault opens with (Electron's `ensureDefaultTaskProject`), through a real
//! session open and the core's task surface.

use std::path::Path;
use std::sync::{Arc, Mutex};

use memry_core::api::task_records::ProjectItem;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::domain::projects;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::sync::apply::apply_inbound_on;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenStage, Session};
use memry_desktop::tasks::defaults;
use serde_json::json;

use crate::device_key;

struct Fixture {
    dir: tempfile::TempDir,
    store: Arc<dyn SecureStore>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            store: device_key::with_device_key(),
        }
    }

    /// A session as the app builds it, with the defaults registered when `seeding`.
    fn session(&self, seeding: bool) -> Session {
        let app = self.dir.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        let config = Arc::new(AppConfig::load(app.join("memry-config.json")));
        let session = Session::new(VaultRegistry::new(config));
        if seeding {
            defaults::register(&session, self.store.clone());
        }
        session
    }

    fn vault(&self) -> std::path::PathBuf {
        let path = self.dir.path().join("vault");
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn projects(&self, session: &Session) -> Vec<ProjectItem> {
        let open = session.current().expect("a vault is open");
        open.vault
            .tasks(self.store.clone())
            .unwrap()
            .projects(true)
            .unwrap()
    }
}

fn outbox_rows(session: &Session, id: &'static str) -> i64 {
    let open = session.current().unwrap();
    open.vault
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE item_type = 'project' AND item_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap()
}

/// The clock column of a project record: `None` until a sync pass seeds it.
fn stored_clock(session: &Session, id: &'static str) -> Option<String> {
    let open = session.current().unwrap();
    open.vault
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT clock FROM sync_items WHERE item_type = 'project' AND item_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap()
}

/// The stored payload of the `inbox` record.
fn stored_inbox(session: &Session) -> serde_json::Value {
    let open = session.current().unwrap();
    let raw: String = open
        .vault
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT payload FROM sync_items WHERE item_type = 'project' AND item_id = 'inbox'",
                    [],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

/// The sync pass's project seed, as the driver runs it after a pull that reached the feed head.
fn pass_seed(session: &Session, device: &'static str) -> Vec<String> {
    let open = session.current().unwrap();
    open.vault
        .db_handle()
        .call_blocking(move |conn| projects::seed_unclocked(conn, device, 1_000))
        .unwrap()
}

fn status(id: &str, name: &str, position: i64, default: bool, done: bool) -> serde_json::Value {
    json!({"id": id, "projectId": "inbox", "name": name, "color": "#6b7280", "position": position,
           "isDefault": default, "isDone": done, "createdAt": "2025-01-01T00:00:00.000Z"})
}

/// The Inbox an Electron device seeded and the user then customised
/// (`apps/desktop/src/main/database/defaults.ts:24`): renamed, its first status renamed, a status
/// of its own added, a note linked.
fn electron_inbox() -> serde_json::Value {
    let clock = json!({"electron-device": 4});
    json!({
        "name": "Capture", "description": "Quick capture for tasks", "color": "#6366f1",
        "icon": "📥", "position": 0, "isInbox": true,
        "statuses": [
            status("inbox-todo", "Backlog", 0, true, false),
            status("inbox-in-progress", "In Progress", 1, false, false),
            status("inbox-review", "Review", 2, false, false),
            status("inbox-done", "Done", 3, false, true),
        ],
        "links": [{"id": "link-1", "projectId": "inbox", "itemType": "note", "itemId": "note-1",
                   "position": 0, "pinned": 1, "createdAt": "2025-01-01T00:00:00.000Z"}],
        "clock": clock,
        "fieldClocks": {
            "name": clock, "description": clock, "color": clock, "icon": clock,
            "position": clock, "isInbox": clock, "archivedAt": clock, "modifiedAt": clock,
            "homeNoteId": clock
        },
        "createdAt": "2025-01-01T00:00:00.000Z", "modifiedAt": "2025-01-02T00:00:00.000Z"
    })
}

/// Applies `payload` as the pull applies a record of the feed.
fn pull(session: &Session, payload: &serde_json::Value, signer: &str) {
    let record = InboundRecord {
        item_type: "project".into(),
        item_id: "inbox".into(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some(signer.into()),
        updated_at: 1,
        deleted_at: None,
    };
    let open = session.current().unwrap();
    open.vault
        .db_handle()
        .call_blocking(move |conn| {
            apply_inbound_on(conn, &record, 1, None)?;
            Ok(())
        })
        .unwrap();
}

fn open(session: &Session, vault: &Path) {
    session.open(vault, OpenSource::Select).expect("open");
}

#[test]
fn a_vault_created_here_opens_with_electrons_inbox_unclocked_and_unqueued() {
    let f = Fixture::new();
    let session = f.session(true);
    session
        .create(f.dir.path(), "Fresh")
        .expect("create the vault");

    let projects = f.projects(&session);
    assert_eq!(projects.len(), 1, "{projects:?}");
    let inbox = &projects[0];
    assert_eq!(
        (
            inbox.id.as_str(),
            inbox.name.as_str(),
            inbox.description.as_deref(),
            inbox.color.as_str(),
            inbox.icon.as_deref(),
            inbox.position,
            inbox.is_inbox,
        ),
        (
            "inbox",
            "Inbox",
            Some("Quick capture for tasks"),
            "#6366f1",
            Some("📥"),
            0,
            true
        )
    );
    let statuses: Vec<_> = inbox
        .statuses
        .iter()
        .map(|s| {
            (
                s.id.as_str(),
                s.name.as_str(),
                s.color.as_str(),
                s.position,
                s.is_default,
                s.is_done,
            )
        })
        .collect();
    assert_eq!(
        statuses,
        [
            ("inbox-todo", "To Do", "#6b7280", 0, true, false),
            (
                "inbox-in-progress",
                "In Progress",
                "#F59E0B",
                1,
                false,
                false
            ),
            ("inbox-done", "Done", "#22c55e", 2, false, true),
        ]
    );
    assert_eq!(
        outbox_rows(&session, "inbox"),
        0,
        "nothing queued before a pass pulled what other devices hold"
    );
    assert_eq!(stored_clock(&session, "inbox"), None);
    session.close();
}

/// The sticky send (#5092) files a task into the live project flagged `is_inbox` and refuses
/// with `sticky_project_missing` when there is none.
#[test]
fn a_task_with_no_project_has_the_inbox_to_land_in() {
    let f = Fixture::new();
    let session = f.session(true);
    open(&session, &f.vault());

    let open = session.current().unwrap();
    let tasks = open.vault.tasks(f.store.clone()).unwrap();
    let live = tasks.projects(false).unwrap();
    let inbox = live
        .iter()
        .find(|project| project.is_inbox)
        .expect("the vault has an Inbox");
    let made = tasks
        .create(NewTaskInput {
            title: "From a sticky".into(),
            project_id: inbox.id.clone(),
            status_id: None,
            parent_id: None,
            priority: 0,
            description: None,
            due_date: None,
            due_time: None,
            start_date: None,
            repeat: None,
            repeat_from: None,
            tags: Vec::new(),
            linked_note_ids: Vec::new(),
            linked_canvas_ids: Vec::new(),
            source_note_id: None,
            position: None,
        })
        .expect("the task lands in the Inbox");
    let task = tasks.get(made.created[0].clone()).unwrap().unwrap();
    assert_eq!(task.project_id, "inbox");
    session.close();
}

#[test]
fn reopening_a_vault_seeds_nothing_more() {
    let f = Fixture::new();
    let vault = f.vault();
    let session = f.session(true);
    open(&session, &vault);
    session.close();
    open(&session, &vault);

    assert_eq!(f.projects(&session).len(), 1);
    assert_eq!(outbox_rows(&session, "inbox"), 0, "no write queued");
    let open = session.current().unwrap();
    assert!(
        !open
            .vault
            .tasks(f.store.clone())
            .unwrap()
            .ensure_inbox()
            .unwrap(),
        "the seed is a no-op on a vault that has its Inbox"
    );
    session.close();
}

#[test]
fn a_vault_synced_from_a_device_that_seeded_keeps_that_inbox() {
    let f = Fixture::new();
    let vault = f.vault();
    // The first open pulls the Electron device's Inbox before anything seeds here.
    let pulling = f.session(false);
    open(&pulling, &vault);
    pull(&pulling, &electron_inbox(), "electron-device");
    pulling.close();

    let session = f.session(true);
    open(&session, &vault);
    let projects = f.projects(&session);
    assert_eq!(
        projects
            .iter()
            .map(|p| (p.id.as_str(), p.name.as_str(), p.is_inbox))
            .collect::<Vec<_>>(),
        [("inbox", "Capture", true)],
        "one Inbox, the synced one, unchanged"
    );
    assert_eq!(outbox_rows(&session, "inbox"), 0, "nothing pushed back");
    session.close();
}

/// A device joining a vault seeds before its first pull. The pulled Inbox replaces the seed
/// outright: Electron's statuses and links all survive, and nothing of the seed is pushed back
/// (REVIEW-5111: a clocked seed merged concurrently and kept the seed's statuses and links).
#[test]
fn a_pull_after_the_seed_keeps_every_status_and_link_of_the_synced_inbox() {
    let f = Fixture::new();
    let session = f.session(true);
    open(&session, &f.vault());
    pull(&session, &electron_inbox(), "electron-device");

    let projects = f.projects(&session);
    assert_eq!(projects.len(), 1, "{projects:?}");
    assert_eq!(projects[0].name, "Capture");
    let statuses: Vec<(&str, &str)> = projects[0]
        .statuses
        .iter()
        .map(|s| (s.id.as_str(), s.name.as_str()))
        .collect();
    assert_eq!(
        statuses,
        [
            ("inbox-todo", "Backlog"),
            ("inbox-in-progress", "In Progress"),
            ("inbox-review", "Review"),
            ("inbox-done", "Done"),
        ]
    );
    let open = session.current().unwrap();
    let links = open
        .vault
        .tasks(f.store.clone())
        .unwrap()
        .project_links("inbox".into())
        .unwrap();
    assert_eq!(links.len(), 1, "the synced link survives");
    assert_eq!(outbox_rows(&session, "inbox"), 0, "nothing pushed back");
    session.close();
}

/// A vault no pull brought an Inbox to: the first pass clocks the seed and queues it, once.
#[test]
fn the_first_pass_queues_a_seed_no_pull_replaced() {
    let f = Fixture::new();
    let session = f.session(true);
    open(&session, &f.vault());
    assert_eq!(outbox_rows(&session, "inbox"), 0);

    assert_eq!(pass_seed(&session, "device-a"), ["inbox"]);
    assert_eq!(outbox_rows(&session, "inbox"), 1, "queued for the push");
    let payload = stored_inbox(&session);
    assert_eq!(payload["clock"], json!({"device-a": 1}));
    assert_eq!(payload["fieldClocks"]["name"], json!({"device-a": 1}));
    assert_eq!(
        stored_clock(&session, "inbox").as_deref(),
        Some(r#"{"device-a":1}"#)
    );
    assert!(pass_seed(&session, "device-a").is_empty(), "seeded once");
    assert_eq!(outbox_rows(&session, "inbox"), 1);
    session.close();
}

/// Two new devices on one vault meet on one Inbox, whichever pushes first, and when both pushed
/// before either pulled.
#[test]
fn two_new_devices_meet_on_one_inbox() {
    let (fa, fb) = (Fixture::new(), Fixture::new());
    let (a, b) = (fa.session(true), fb.session(true));
    open(&a, &fa.vault());
    open(&b, &fb.vault());

    // A pushes first; B pulls it before its own pass seeds anything.
    assert_eq!(pass_seed(&a, "device-a"), ["inbox"]);
    assert_eq!(outbox_rows(&a, "inbox"), 1, "A queued its seed");
    pull(&b, &stored_inbox(&a), "device-a");
    assert!(
        pass_seed(&b, "device-b").is_empty(),
        "B's seed was replaced"
    );
    assert_eq!(outbox_rows(&b, "inbox"), 0, "B pushes nothing back");
    assert_eq!(stored_inbox(&b)["clock"], json!({"device-a": 1}));
    assert_eq!(fb.projects(&b).len(), 1);

    // Two more devices that both seeded and pushed before either pulled.
    let (fc, fd) = (Fixture::new(), Fixture::new());
    let (c, d) = (fc.session(true), fd.session(true));
    open(&c, &fc.vault());
    open(&d, &fd.vault());
    pass_seed(&c, "device-c");
    pass_seed(&d, "device-d");
    assert_eq!(
        (outbox_rows(&c, "inbox"), outbox_rows(&d, "inbox")),
        (1, 1),
        "C and D queued their seeds"
    );
    let (from_c, from_d) = (stored_inbox(&c), stored_inbox(&d));
    pull(&c, &from_d, "device-d");
    pull(&d, &from_c, "device-c");
    for (fixture, session) in [(&fc, &c), (&fd, &d)] {
        let projects = fixture.projects(session);
        assert_eq!(
            projects
                .iter()
                .map(|p| (p.id.as_str(), p.name.as_str(), p.statuses.len()))
                .collect::<Vec<_>>(),
            [("inbox", "Inbox", 3)]
        );
        assert_eq!(
            stored_inbox(session)["clock"],
            json!({"device-c": 1, "device-d": 1})
        );
    }
    for session in [&a, &b, &c, &d] {
        session.close();
    }
}

/// The seed runs before sync starts, as Electron's precedes its sync: a hook of the first
/// sync stage already finds the Inbox.
#[test]
fn the_inbox_is_seeded_before_sync_starts() {
    let f = Fixture::new();
    let session = f.session(false);
    let seen = Arc::new(Mutex::new(None::<bool>));
    let probe = Arc::clone(&seen);
    // Registered first, so it runs before a seed registered in the same stage.
    session.on_open(
        "probe",
        OpenStage::SyncStart,
        Arc::new(move |view| {
            let held = view
                .vault
                .db_handle()
                .call_blocking(|conn| {
                    Ok(conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = 'inbox')",
                            [],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap())
                })
                .unwrap();
            *probe.lock().unwrap() = Some(held);
            Ok(())
        }),
    );
    defaults::register(&session, f.store.clone());
    open(&session, &f.vault());
    assert_eq!(*seen.lock().unwrap(), Some(true));
    session.close();
}

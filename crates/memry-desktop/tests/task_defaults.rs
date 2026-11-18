//! The Inbox every vault opens with (Electron's `ensureDefaultTaskProject`), through a real
//! session open and the core's task surface.

use std::path::Path;
use std::sync::Arc;

use memry_core::api::task_records::ProjectItem;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
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

/// What an Electron device that seeded and then renamed its Inbox pushes
/// (`apps/desktop/src/main/database/defaults.ts:24`).
fn electron_inbox(session: &Session) {
    let payload = json!({
        "name": "Capture", "description": "Quick capture for tasks", "color": "#6366f1",
        "icon": "📥", "position": 0, "isInbox": true,
        "statuses": [
            {"id": "inbox-todo", "projectId": "inbox", "name": "To Do", "color": "#6b7280",
             "position": 0, "isDefault": true, "isDone": false, "createdAt": "2025-01-01T00:00:00.000Z"},
            {"id": "inbox-done", "projectId": "inbox", "name": "Done", "color": "#22c55e",
             "position": 2, "isDefault": false, "isDone": true, "createdAt": "2025-01-01T00:00:00.000Z"}
        ],
        "clock": {"electron-device": 2},
        "createdAt": "2025-01-01T00:00:00.000Z", "modifiedAt": "2025-01-02T00:00:00.000Z"
    })
    .to_string();
    let open = session.current().unwrap();
    open.vault
        .db_handle()
        .call_blocking(move |conn| {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: "project".into(),
                    item_id: "inbox".into(),
                    payload_json: payload,
                    server_cursor: Some(1),
                    signer_device_id: Some("electron-device".into()),
                    updated_at: 1,
                    deleted_at: None,
                },
                1,
            )?;
            Ok(())
        })
        .unwrap();
}

fn open(session: &Session, vault: &Path) {
    session.open(vault, OpenSource::Select).expect("open");
}

#[test]
fn a_vault_created_here_opens_with_electrons_inbox_queued_for_sync() {
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
        1,
        "the seed syncs to other devices"
    );
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
    assert_eq!(outbox_rows(&session, "inbox"), 1, "no second write");
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
    electron_inbox(&pulling);
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

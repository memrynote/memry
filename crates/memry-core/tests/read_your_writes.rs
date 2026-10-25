//! A read answered by the pool sees what a write just committed (Tauri epic
//! Step 08b).
//!
//! Reads run on pooled read-only connections. Each module family below writes
//! through its public API on a file-backed vault, then reads the result back
//! through the read path of the same family, so a read that was misrouted to a
//! stale or write-demanding connection fails here. In-memory databases, which
//! most unit tests use, have no pool; these tests do.

mod http_fakes;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::FakeSecureStore;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::search::BacklinkOrder;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    dir: std::path::PathBuf,
    vault: Vault,
    store: Arc<FakeSecureStore>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("memry-ryw-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_owned(), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[5u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    Fixture { dir, vault, store }
}

fn new_task(title: &str, project_id: &str) -> NewTaskInput {
    NewTaskInput {
        title: title.to_owned(),
        project_id: project_id.to_owned(),
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
    }
}

#[test]
fn notes_see_a_note_and_its_tags_right_after_the_write() {
    let f = fixture();
    let writer = f.vault.notes_writer(f.store.clone()).expect("writer");
    let notes = f.vault.notes();
    let tasks = f.vault.tasks(f.store.clone()).expect("tasks");

    let id = writer.create("Plans".to_owned(), None).expect("create");
    assert!(notes.list().expect("list").iter().any(|n| n.id == id));
    assert!(notes.read(id.clone()).expect("read").is_some());

    writer
        .set_tags(id.clone(), vec!["alpha".to_owned()])
        .expect("tag");
    assert_eq!(
        notes
            .notes_tagged("alpha".to_owned())
            .expect("tagged")
            .len(),
        1
    );
    assert!(
        tasks
            .tag_list()
            .expect("tags")
            .iter()
            .any(|t| t.name == "alpha")
    );

    writer
        .rename(id.clone(), "Plans v2".to_owned())
        .expect("rename");
    assert!(
        notes
            .list()
            .expect("list")
            .iter()
            .any(|n| n.title == "Plans v2")
    );
}

#[test]
fn tasks_and_projects_see_a_write_right_after_it() {
    let f = fixture();
    let tasks = f.vault.tasks(f.store.clone()).expect("tasks");

    let project = tasks
        .create_project(ProjectDraft {
            name: "Home".to_owned(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .expect("project");
    assert!(
        tasks
            .projects(false)
            .expect("projects")
            .iter()
            .any(|p| p.id == project)
    );

    let id = tasks
        .create(new_task("Water plants", &project))
        .expect("task")
        .created[0]
        .clone();
    assert!(tasks.all().expect("all").iter().any(|t| t.id == id));
    assert!(tasks.tree().expect("tree").iter().any(|t| t.id == id));
    assert!(tasks.get(id).expect("get").is_some());
}

#[test]
fn journal_sees_a_day_right_after_the_write() {
    let f = fixture();
    let journal = f.vault.journal(f.store.clone()).expect("journal");

    assert!(journal.day("2026-03-04".to_owned()).expect("day").is_none());
    journal
        .set_tags("2026-03-04".to_owned(), vec!["trip".to_owned()])
        .expect("tag the day");
    assert!(journal.day("2026-03-04".to_owned()).expect("day").is_some());
    assert!(
        journal
            .entry_id("2026-03-04".to_owned())
            .expect("id")
            .is_some()
    );
}

#[test]
fn settings_see_a_value_right_after_it_is_set() {
    let f = fixture();
    let settings = f.vault.settings(f.store.clone()).expect("settings");

    let before = settings.revision().expect("revision");
    settings
        .set("general.theme".to_owned(), "\"dark\"".to_owned())
        .expect("set");
    assert_eq!(
        settings
            .get("general.theme".to_owned())
            .expect("get")
            .as_deref(),
        Some("\"dark\"")
    );
    assert!(settings.revision().expect("revision") > before);
}

#[test]
fn inbox_and_canvases_see_a_capture_right_after_it() {
    let f = fixture();
    let inbox = f.vault.inbox(f.store.clone()).expect("inbox");
    let canvases = f.vault.canvases(f.store.clone()).expect("canvases");

    let captured = inbox
        .capture_text("remember the milk".to_owned(), None, None, false)
        .expect("capture")
        .item
        .id;
    assert!(
        inbox
            .list(true)
            .expect("list")
            .iter()
            .any(|i| i.id == captured)
    );
    assert!(inbox.get(captured).expect("get").is_some());

    let canvas = canvases
        .create(Some("Board".to_owned()), None, None)
        .expect("create")
        .id;
    assert!(canvases.canvas(canvas).expect("canvas").is_some());
}

#[test]
fn search_sees_a_note_after_the_index_catches_up() {
    let f = fixture();
    let writer = f.vault.notes_writer(f.store.clone()).expect("writer");
    let search = f.vault.search().expect("search");

    let id = writer
        .create("Zanzibar itinerary".to_owned(), None)
        .expect("create");
    search.reindex().expect("reindex");
    assert!(
        search
            .notes("Zanzibar".to_owned(), 10)
            .expect("search")
            .iter()
            .any(|r| r.id == id)
    );
    assert!(search.links_from(id.clone()).expect("links").is_empty());
    assert!(
        search
            .links_to(id, BacklinkOrder::Recent)
            .expect("links to")
            .is_empty()
    );
}

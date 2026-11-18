//! The sticky's send and undo (Step 31c, #3548) on a real vault: `StickySend`, the whole of
//! `sendSticky` and `undoStickySend`, over the notes service, core tasks, the settings and the
//! drafts the app's own commands use. `commands/sticky_send.rs` only tells the windows.
//!
//! | Test                                                        | Rule (`stickies/send.ts`)           |
//! | ----------------------------------------------------------- | ----------------------------------- |
//! | a note send makes the Sticky folder and deletes the draft   | `sendToNote`, draft after the send  |
//! | a first line too long for a title is kept whole in the body | REVIEW-5092 3                       |
//! | a note send uses the folder as the disk spells it           | REVIEW-5092 5                       |
//! | an excluded Sticky folder refuses and keeps the draft       | REVIEW-5092 5                       |
//! | a kind turned off refuses and keeps the draft               | `assertKindEnabled`                 |
//! | a task send lands in the inbox and remembers the kind       | `sendToTask`, `rememberStickyKind`  |
//! | a task send with no inbox project is refused                | `PROJECT_MISSING_ERROR`             |
//! | an undo restores the draft and deletes the task             | `undoStickySend`                    |
//! | an undo whose note is gone keeps no restored draft          | REVIEW-5092 7                       |
//! | a journal send appends a paragraph to the day               | `appendToJournalEntry`              |
//! | a journal send to a day with no file makes the day          | `updateJournalEntry` makes the day  |
//! | journal sends at once each keep their paragraph             | REVIEW-5092 2                       |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::sync::Arc;

use memry_core::domain::calendar::LocalDateTime;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::AppConfig;
use memry_desktop::session::OpenVault;
use memry_desktop::settings::SettingsService;
use memry_desktop::sticky::drafts::{self, StickyKind, StickyStore};
use memry_desktop::sticky::send::{
    Landed, STICKY_FOLDER, SendError, SendInput, StickySend, UndoLedger,
};
use serde_json::{Map, json};

use crate::journal_folder::{daily, make_day};
use crate::vault_settings::opened_keeping;
use vault_env::Env;

const DAY: &str = "2025-01-02";

struct World {
    e: Env,
    open: OpenVault,
    store: Arc<dyn SecureStore>,
    notes: Arc<NotesService>,
    settings: SettingsService,
    drafts: StickyStore,
    ledger: UndoLedger,
    _app: tempfile::TempDir,
}

fn world() -> World {
    let (e, store) = opened_keeping(daily("journal"), &[]);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let app = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(app.path().join("memry-config.json")));
    let open = e.session.current().unwrap();
    World {
        drafts: drafts::open(&open, store.clone()).unwrap(),
        settings: SettingsService::new(store.clone(), config),
        ledger: UndoLedger::default(),
        notes,
        open,
        store,
        e,
        _app: app,
    }
}

impl World {
    fn flow(&self) -> StickySend<'_> {
        StickySend {
            notes: &self.notes,
            open: &self.open,
            settings: &self.settings,
            drafts: &self.drafts,
            ledger: &self.ledger,
        }
    }

    /// A draft of `content`, sent as `kind`.
    fn send(&self, content: &str, kind: StickyKind) -> (String, Result<Landed, SendError>) {
        let draft = self.drafts.save(None, content.to_owned(), kind).unwrap();
        let input = SendInput {
            draft_id: Some(draft.id.clone()),
            content: content.to_owned(),
            kind,
        };
        (draft.id, self.flow().send(input, now(), 1_000))
    }

    fn has_draft(&self, id: &str) -> bool {
        self.drafts
            .list()
            .unwrap()
            .iter()
            .any(|draft| draft.id == id)
    }

    fn set(&self, group: &str, patch: serde_json::Value) {
        let patch: Map<String, serde_json::Value> = serde_json::from_value(patch).unwrap();
        self.settings
            .write_group(Some(&self.open), group, patch)
            .unwrap();
    }

    fn file(&self, path: &str) -> String {
        fs::read_to_string(self.e.vault.join(path)).unwrap()
    }
}

fn now() -> LocalDateTime {
    LocalDateTime::parse("2025-01-02T09:00:00").unwrap()
}

#[test]
fn a_note_send_makes_the_sticky_folder_and_deletes_the_draft() {
    let w = world();
    let (draft, landed) = w.send("  Milk\noat, 2 l\n", StickyKind::Note);
    let landed = landed.unwrap();
    assert_eq!(landed.sent.title, "Milk");
    assert!(landed.draft_deleted && !w.has_draft(&draft));
    assert!(landed.undo_token.is_some());
    assert!(w.file("Sticky/Milk.md").contains("oat, 2 l"));
    // A second send reuses the folder.
    w.send("Bread", StickyKind::Note).1.unwrap();
    assert!(w.e.vault.join("Sticky/Bread.md").exists());
}

#[test]
fn a_first_line_too_long_for_a_title_is_kept_whole_in_the_body() {
    let w = world();
    // 199 units, then an emoji of two: the title stops before it.
    let line = format!("{}\u{1F600} and more", "a".repeat(199));
    let landed = w
        .send(&format!("{line}\nsecond"), StickyKind::Note)
        .1
        .unwrap();
    assert_eq!(landed.sent.title, "a".repeat(199));
    let file = w.file(&format!("Sticky/{}.md", "a".repeat(199)));
    assert!(file.contains(&format!("{line}\nsecond")), "{file}");
}

#[test]
fn a_note_send_uses_the_folder_as_the_disk_spells_it() {
    let w = world();
    fs::create_dir(w.e.vault.join("sticky")).unwrap();
    w.send("Milk", StickyKind::Note).1.unwrap();
    let names: Vec<String> = fs::read_dir(&w.e.vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.eq_ignore_ascii_case(STICKY_FOLDER))
        .collect();
    assert_eq!(names, vec!["sticky".to_owned()]);
    assert!(w.e.vault.join("sticky").join("Milk.md").exists());
}

#[test]
fn an_excluded_sticky_folder_refuses_and_keeps_the_draft() {
    let w = world();
    w.open
        .vault
        .excluded()
        .set(|path| path == STICKY_FOLDER || path.starts_with("Sticky/"));
    let (draft, landed) = w.send("Milk", StickyKind::Note);
    assert!(
        matches!(landed, Err(SendError::FolderExcluded)),
        "{landed:?}"
    );
    assert!(w.has_draft(&draft));
    assert!(!w.e.vault.join(STICKY_FOLDER).exists());
}

#[test]
fn a_kind_turned_off_refuses_and_keeps_the_draft() {
    let w = world();
    w.set("features", json!({ "tasks": false, "journal": false }));
    let (task, landed) = w.send("Milk", StickyKind::Task);
    assert!(matches!(landed, Err(SendError::TasksOff)), "{landed:?}");
    let (day, landed) = w.send("Milk", StickyKind::Journal);
    assert!(matches!(landed, Err(SendError::JournalOff)), "{landed:?}");
    assert!(w.has_draft(&task) && w.has_draft(&day));
    assert!(
        w.e.vault
            .join("journal")
            .read_dir()
            .map_or(true, |mut d| d.next().is_none())
    );
}

#[test]
fn a_task_send_lands_in_the_inbox_and_remembers_the_kind() {
    let w = world();
    let tasks = w.open.vault.tasks(w.store.clone()).unwrap();
    tasks.ensure_inbox().unwrap();
    w.set("tasks", json!({ "defaultProjectId": "gone" }));
    let (draft, landed) = w.send(
        "Call Ana @tomorrow !high\nabout the lease",
        StickyKind::Task,
    );
    let landed = landed.unwrap();
    assert!(!w.has_draft(&draft));
    let task = tasks
        .all()
        .unwrap()
        .into_iter()
        .find(|task| task.id == landed.sent.target_id)
        .unwrap();
    assert_eq!(task.title, "Call Ana");
    assert_eq!(task.description.as_deref(), Some("about the lease"));
    assert_eq!(task.priority, 3);
    // The default project is gone, so the task lands in the inbox.
    assert_eq!(task.project_id, "inbox");
    assert!(landed.remembered.is_some());
    let sticky = w
        .settings
        .read_group(Some(&w.open), "sticky")
        .unwrap()
        .value;
    assert_eq!(sticky["lastKind"], "task");
    // The same kind again writes nothing.
    assert!(
        w.send("Bread", StickyKind::Task)
            .1
            .unwrap()
            .remembered
            .is_none()
    );
}

#[test]
fn a_task_send_with_no_inbox_project_is_refused() {
    let w = world();
    let (draft, landed) = w.send("Milk", StickyKind::Task);
    assert!(
        matches!(landed, Err(SendError::ProjectMissing)),
        "{landed:?}"
    );
    assert!(w.has_draft(&draft));
    let tasks = w.open.vault.tasks(w.store.clone()).unwrap();
    assert!(tasks.all().unwrap().is_empty());
}

#[test]
fn an_undo_restores_the_draft_and_deletes_the_task() {
    let w = world();
    let tasks = w.open.vault.tasks(w.store.clone()).unwrap();
    tasks.ensure_inbox().unwrap();
    let landed = w.send("Milk", StickyKind::Task).1.unwrap();
    let draft = w
        .flow()
        .undo(landed.undo_token.as_deref().unwrap(), 2_000)
        .unwrap();
    assert_eq!(
        (draft.content.as_str(), draft.kind.as_str()),
        ("Milk", "task")
    );
    assert!(w.has_draft(&draft.id));
    assert!(
        tasks
            .all()
            .unwrap()
            .iter()
            .all(|task| task.id != landed.sent.target_id)
    );
    // A token is taken once.
    let again = w.flow().undo(landed.undo_token.as_deref().unwrap(), 2_000);
    assert!(matches!(again, Err(SendError::UndoExpired)), "{again:?}");
}

#[test]
fn an_undo_whose_note_is_gone_keeps_no_restored_draft() {
    let w = world();
    let landed = w.send("Milk", StickyKind::Note).1.unwrap();
    w.notes
        .delete(&w.open, &landed.sent.target_id, false)
        .unwrap();
    let undone = w.flow().undo(landed.undo_token.as_deref().unwrap(), 2_000);
    assert!(
        matches!(undone, Err(SendError::Notes(NotesError::NotFound(_)))),
        "{undone:?}"
    );
    assert!(w.drafts.list().unwrap().is_empty());
}

#[test]
fn a_journal_send_appends_a_paragraph_to_the_day() {
    let w = world();
    make_day(&w.notes, &w.e, DAY);
    let landed = w.send("  Called Ana\n", StickyKind::Journal).1.unwrap();
    assert_eq!(landed.sent.target_id, DAY);
    assert!(landed.undo_token.is_none());
    let day = landed.day.unwrap();
    assert!(!day.created);
    assert_eq!(day.entry.content, "Later\n\nCalled Ana");
    let file = w.file(&format!("journal/{DAY}.md"));
    assert!(file.trim_end().ends_with("Later\n\nCalled Ana"), "{file}");
}

#[test]
fn a_journal_send_to_a_day_with_no_file_makes_the_day() {
    let w = world();
    let day = w
        .send("Called Ana", StickyKind::Journal)
        .1
        .unwrap()
        .day
        .unwrap();
    assert!(day.created);
    let file = w.file(&format!("journal/{DAY}.md"));
    assert!(file.trim_end().ends_with("Called Ana"), "{file}");
}

#[test]
fn journal_sends_at_once_each_keep_their_paragraph() {
    let w = world();
    make_day(&w.notes, &w.e, DAY);
    std::thread::scope(|scope| {
        for thread in 0..2 {
            let w = &w;
            scope.spawn(move || {
                for round in 0..5 {
                    w.notes
                        .append_to_day(&w.open, DAY, &format!("t{thread} r{round}"))
                        .unwrap();
                }
            });
        }
    });
    let file = w.file(&format!("journal/{DAY}.md"));
    for thread in 0..2 {
        for round in 0..5 {
            assert!(
                file.contains(&format!("t{thread} r{round}")),
                "t{thread} r{round} lost: {file}"
            );
        }
    }
}

//! The sticky's send targets (Step 31c, #3548) on a real vault: a note in the `Sticky` folder, a
//! task, and a paragraph appended to a day, each through the service the app's own commands use;
//! the undo of a note and a task send. The command adapter is `commands/sticky_send.rs`.
//!
//! | Test                                                  | Rule (`stickies/send.ts`)            |
//! | ----------------------------------------------------- | ------------------------------------ |
//! | a note send makes the Sticky folder and its undo ...  | `sendToNote`, `undoStickySend`       |
//! | a task send parses the first line and its undo ...    | `sendToTask`, `toStickyTaskInput`    |
//! | a journal send appends a paragraph to the day         | `appendToJournalEntry`               |
//! | a journal send to a day with no file makes the day    | `updateJournalEntry` makes the day   |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;

use memry_core::domain::calendar::LocalDateTime;
use memry_desktop::notes::service::NotesService;
use memry_desktop::sticky::drafts::StickyKind;
use memry_desktop::sticky::send::{STICKY_FOLDER, UndoLedger};

use crate::journal_folder::{daily, make_day};
use crate::vault_settings::opened_keeping;

const DAY: &str = "2025-01-02";

fn now() -> LocalDateTime {
    LocalDateTime::parse("2025-01-02T09:00:00").unwrap()
}

#[test]
fn a_note_send_makes_the_sticky_folder_and_its_undo_trashes_the_note() {
    let (e, store) = opened_keeping(daily("journal"), &[]);
    let notes = NotesService::new(e.tier.clone(), store);
    let open = e.session.current().unwrap();

    let sent = notes.send_sticky_note(&open, "  Milk\noat, 2 l\n").unwrap();
    assert_eq!(sent.title, "Milk");
    let file = e.vault.join(STICKY_FOLDER).join("Milk.md");
    assert!(fs::read_to_string(&file).unwrap().contains("oat, 2 l"));

    // A second send reuses the folder.
    notes.send_sticky_note(&open, "Bread").unwrap();
    assert!(e.vault.join(STICKY_FOLDER).join("Bread.md").exists());

    let ledger = UndoLedger::default();
    let token = ledger
        .record(StickyKind::Note, &sent, "Milk\noat, 2 l", 0)
        .unwrap();
    let undo = ledger.take(&token, 1).unwrap();
    notes.undo_sticky_send(&open, &undo).unwrap();
    assert!(!file.exists());
}

#[test]
fn a_task_send_parses_the_first_line_and_its_undo_deletes_the_task() {
    let (e, store) = opened_keeping(daily("journal"), &[]);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let open = e.session.current().unwrap();
    let tasks = open.vault.tasks(store).unwrap();
    tasks.ensure_inbox().unwrap();

    let sent = notes
        .send_sticky_task(
            &open,
            "Call Ana @tomorrow !high\nabout the lease",
            Some("gone"),
            now(),
        )
        .unwrap();
    assert_eq!(sent.title, "Call Ana");
    let task = tasks
        .all()
        .unwrap()
        .into_iter()
        .find(|task| task.id == sent.target_id)
        .unwrap();
    assert_eq!(task.title, "Call Ana");
    assert_eq!(task.description.as_deref(), Some("about the lease"));
    assert_eq!(task.priority, 3);
    // The default project is gone, so the task lands in the inbox.
    assert_eq!(task.project_id, "inbox");

    let ledger = UndoLedger::default();
    let token = ledger
        .record(StickyKind::Task, &sent, "Call Ana", 0)
        .unwrap();
    notes
        .undo_sticky_send(&open, &ledger.take(&token, 1).unwrap())
        .unwrap();
    assert!(
        tasks
            .all()
            .unwrap()
            .iter()
            .all(|task| task.id != sent.target_id)
    );
}

#[test]
fn a_journal_send_appends_a_paragraph_to_the_day() {
    let (e, store) = opened_keeping(daily("journal"), &[]);
    let notes = NotesService::new(e.tier.clone(), store);
    make_day(&notes, &e, DAY);
    let open = e.session.current().unwrap();

    let updated = notes
        .send_sticky_journal(&open, "  Called Ana\n", DAY)
        .unwrap();
    assert!(!updated.created);
    assert_eq!(updated.entry.content, "Later\n\nCalled Ana");
    let file = fs::read_to_string(e.vault.join("journal").join(format!("{DAY}.md"))).unwrap();
    assert!(file.trim_end().ends_with("Later\n\nCalled Ana"), "{file}");
}

#[test]
fn a_journal_send_to_a_day_with_no_file_makes_the_day() {
    let (e, store) = opened_keeping(daily("journal"), &[]);
    let notes = NotesService::new(e.tier.clone(), store);
    let open = e.session.current().unwrap();

    let updated = notes.send_sticky_journal(&open, "Called Ana", DAY).unwrap();
    assert!(updated.created);
    let file = fs::read_to_string(e.vault.join("journal").join(format!("{DAY}.md"))).unwrap();
    assert!(file.trim_end().ends_with("Called Ana"), "{file}");
}

//! The first file of a note or day no row names (`unfiled`): a record pulled from another
//! device, as the core keeps it before any file is written here.

use memry_core::crdt::body_edit::BlockEdit;
use serde_json::json;

use super::{Fixture, assert_wrote, fixture};
use crate::vault::config::config_path;
use crate::vault::writeback::{Keep, Outcome};

/// The consumer's open walk ended: every file on disk has a row.
fn walked(f: &Fixture) {
    f.rows.lane_of(f.pass.session).unwrap().set_walked(true);
}

/// A note with other names and a cover, made in no folder.
fn pulled_note(f: &Fixture) -> String {
    let id = f.writer.create("Plan".into(), None).unwrap();
    let aliases = vec!["PM".to_owned(), "Roadmap".to_owned()];
    f.writer.set_aliases(id.clone(), aliases).unwrap();
    f.writer
        .set_cover(id.clone(), Some("covers/a.png".into()), 0.3)
        .unwrap();
    id
}

/// Before the walk ends a file on disk may be the note's and have no row: nothing is written.
/// After it, the note's file lands at the vault root (no folder) with the names and cover Electron's
/// pull writes, and its row names it.
#[test]
fn a_pulled_note_gets_its_first_file_once_the_walk_ended() {
    let mut f = fixture();
    let id = pulled_note(&f);
    assert_eq!(f.run(&id), Outcome::Kept(Keep::NoRow));
    assert!(!f.root.join("Plan.md").exists());

    walked(&f);
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, "Plan.md");
    assert_eq!(
        file,
        "---\naliases:\n  - PM\n  - Roadmap\ncover: covers/a.png\ncoverFocus: 30\n---\n"
    );
    let row = f.vault.note_files().by_id(&id).unwrap().expect("a row");
    assert_eq!(row.path, "Plan.md");
}

/// A note whose body has not been pulled gets no file, not an empty one: the pull that brings
/// the body writes it. Red when the skeleton is written while the body is owed.
#[test]
fn a_pulled_note_whose_body_is_owed_gets_no_file() {
    let mut f = fixture();
    let id = pulled_note(&f);
    f.owe_server_body(&id);
    walked(&f);
    assert_eq!(f.run(&id), Outcome::Kept(Keep::BodyNotPulled));
    assert!(!f.root.join("Plan.md").exists());
    assert!(f.vault.note_files().by_id(&id).unwrap().is_none());
    assert!(f.facts().is_empty());
}

/// A file made at the note's name after the name was found free stays byte for byte, and the
/// note keeps no row. Red when the first file is written over instead of created.
#[test]
fn a_file_made_at_the_name_meanwhile_stays() {
    let f = fixture();
    let id = pulled_note(&f);
    walked(&f);
    let root = f.root.clone();
    let outcome = f.pass.run_checked(&id, &mut || {
        std::fs::write(root.join("Plan.md"), "outside words\n").unwrap();
    });
    assert_eq!(outcome, Outcome::Kept(Keep::PathTaken));
    assert_eq!(f.read("Plan.md"), "outside words\n");
    assert!(f.vault.note_files().by_id(&id).unwrap().is_none());
}

/// A day pulled with its other names and the reserved keys among its properties: the file's
/// `date` is the day's, and a cover value never lands in it, as a local day create filters
/// them.
#[test]
fn a_pulled_days_reserved_keys_stay_out_of_its_file() {
    let mut f = fixture();
    let date = "2026-11-02";
    let journal = f.vault.journal(f.store.clone()).unwrap();
    let properties = json!({
        "date": "1999-01-01",
        "cover": "wash:sage",
        "mood": "ok",
    });
    let properties = properties.as_object().unwrap().clone();
    let opened = journal.open_with(date, &[], &properties).unwrap();
    let typed = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "day from A".into(),
        new_block_id: "a-day".into(),
    };
    journal.edit_day(date.into(), typed).unwrap();
    journal
        .set_aliases(date.into(), vec!["Launch".into()])
        .unwrap();
    walked(&f);
    let outcome = f.run(&opened.id);
    let file = assert_wrote(&mut f, &outcome, "journal/2026-11-02.md");
    assert!(file.starts_with("---\ndate: '2026-11-02'\n"), "{file:?}");
    assert!(file.contains("mood: ok\n"), "{file:?}");
    assert!(file.contains("aliases:\n  - Launch\n"), "{file:?}");
    for key in ["1999", "cover"] {
        assert!(!file.contains(key), "{key}: {file:?}");
    }
}

/// Settings that cannot be read do not say where the journal is: the day waits, and no file
/// lands in the default `journal/`. Readable again, the day gets its file.
#[test]
fn a_pulled_day_waits_while_the_settings_cannot_be_read() {
    let mut f = fixture();
    let date = "2026-11-02";
    let journal = f.vault.journal(f.store.clone()).unwrap();
    let typed = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "day from A".into(),
        new_block_id: "a-day".into(),
    };
    journal.edit_day(date.into(), typed).unwrap();
    let id = journal.entry_id(date.into()).unwrap().expect("the day");
    walked(&f);
    std::fs::write(config_path(&f.root), "{").unwrap();
    assert_eq!(f.run(&id), Outcome::Kept(Keep::DayWaits));
    assert!(!f.root.join("journal").exists());
    assert!(f.vault.note_files().by_id(&id).unwrap().is_none());

    std::fs::remove_file(config_path(&f.root)).unwrap();
    let outcome = f.run(&id);
    assert_wrote(&mut f, &outcome, "journal/2026-11-02.md");
}

/// A note whose folder cannot be read right now fails the pass, which is tried again, instead
/// of breaking it for good: the folder may read once its permissions come back. Red when a read
/// error in the folder lookup is `Broken`.
#[cfg(unix)]
#[test]
fn a_pulled_note_whose_folder_cannot_be_read_is_tried_again() {
    use std::os::unix::fs::PermissionsExt;

    let mut f = fixture();
    let locked = f.root.join("Locked");
    std::fs::create_dir_all(locked.join("Sub")).unwrap();
    let id = f
        .writer
        .create("Plan".into(), Some("Locked/Sub".into()))
        .unwrap();
    walked(&f);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let outcome = f.run(&id);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
    assert!(f.vault.note_files().by_id(&id).unwrap().is_none());

    let outcome = f.run(&id);
    assert_wrote(&mut f, &outcome, "Locked/Sub/Plan.md");
}

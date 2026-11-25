//! A pulled title, folder, tags or properties of a note with a file (`place`): the file moves
//! and its frontmatter takes the record, behind the pass's guards. The record is changed through
//! this device's writer, as a pulled page leaves it, and the note is marked as the sync
//! observer marks it.

use serde_json::Map;

use super::*;
use crate::notes::properties::text_values;
use crate::vault::consumer::MoveKind;

/// A note named `n` at `n.md` whose document took `text`.
fn note(f: &mut Fixture, text: &str) -> String {
    let id = f.writer.create("n".into(), None).unwrap();
    f.seed(&id, "n.md", text);
    id
}

/// Marks the note as the sync observer does after `change` applied, with the title it had
/// before.
fn pulled(f: &Fixture, id: &str, change: impl FnOnce(&NotesWriter)) {
    let before = f
        .vault
        .note_files()
        .placed(id)
        .unwrap()
        .expect("a note")
        .title;
    change(&f.writer);
    f.pass.mark_pulled(id, Some(&before));
}

fn pulled_rename(f: &Fixture, id: &str, title: &str) {
    pulled(f, id, |w| w.rename(id.to_owned(), title.into()).unwrap());
}

fn pulled_tags(f: &Fixture, id: &str, tags: &[&str]) {
    let tags = tags.iter().map(|tag| (*tag).to_owned()).collect();
    pulled(f, id, |w| w.set_tags(id.to_owned(), tags).unwrap());
}

fn pulled_folder(f: &Fixture, id: &str, folder: &str) {
    pulled(f, id, |w| {
        w.move_to_folder(id.to_owned(), Some(folder.into()))
            .unwrap();
    });
}

fn renamed_facts(f: &mut Fixture) -> usize {
    let facts = f.facts();
    facts
        .iter()
        .filter(|fact| matches!(fact, Applied::Renamed { .. }))
        .count()
}

fn row_path(f: &Fixture, id: &str) -> String {
    f.vault.note_files().by_id(id).unwrap().expect("a row").path
}

/// The file moves to the pulled title's name and is at exactly one path after the pass: the
/// old name is gone, the new one holds the bytes, and the row names it.
#[test]
fn a_pulled_rename_moves_the_file_to_one_place() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert!(!f.root.join("n.md").exists(), "the old file is gone");
    assert_eq!(f.read("Renamed.md"), "first words\n");
    assert_eq!(row_path(&f, &id), "Renamed.md");
    let facts = f.facts();
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Renamed { old_path, new_path, kind: MoveKind::Renamed, .. }
                if old_path == "n.md" && new_path == "Renamed.md"
        )),
        "{facts:?}"
    );
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Changed { path, source: ChangeSource::Sync, .. } if path == "Renamed.md"
        )),
        "{facts:?}"
    );
    // The mark is taken: a second pass finds the file in place and changes nothing.
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert!(f.facts().is_empty());
}

/// A local pass never moves the file, whatever the record's title says (`Pulled`).
#[test]
fn an_unmarked_pass_never_moves_the_file() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    f.writer.rename(id.clone(), "Renamed".into()).unwrap();
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("n.md"), "first words\n");
    assert!(!f.root.join("Renamed.md").exists());
}

/// Another file at the pulled name stays; the note takes the first free number.
#[test]
fn a_taken_name_numbers_the_moved_file() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    f.write("Renamed.md", "someone else's\n");
    pulled_rename(&f, &id, "Renamed");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("Renamed.md"), "someone else's\n");
    assert_eq!(f.read("Renamed 1.md"), "first words\n");
    assert_eq!(row_path(&f, &id), "Renamed 1.md");
}

/// An outside edit the document has not taken is never moved or rewritten, and the mark waits
/// for the pass after the edit is fed.
#[test]
fn an_outside_edit_since_the_last_hash_is_kept_and_the_mark_waits() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    f.write("n.md", "edited outside\n");
    let outcome = f.run(&id);
    assert_kept(
        &mut f,
        &outcome,
        Keep::FileChanged,
        "n.md",
        "edited outside\n",
    );
    assert!(!f.root.join("Renamed.md").exists());

    // The consumer read the file back as it was: the mark is still there.
    f.write("n.md", "first words\n");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("Renamed.md"), "first words\n");
}

/// A missing file is not made again, at the old path or the new one.
#[test]
fn a_missing_file_is_not_recreated() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    std::fs::remove_file(f.root.join("n.md")).unwrap();
    assert_eq!(f.run(&id), Outcome::Kept(Keep::NoFile));
    assert!(!f.root.join("n.md").exists());
    assert!(!f.root.join("Renamed.md").exists());
}

/// A pulled journal day never moves (its record names no folder of a note's), and its
/// frontmatter keeps the day's rules.
#[test]
fn a_journal_day_never_moves() {
    let mut f = fixture();
    let rel = "journal/2025-01-01.md";
    let text = "---\ntags:\n  - mine\n---\nA day.\n";
    let id = f.adopt_day(rel, "2025-01-01", text);
    f.pass.mark_pulled(&id, Some("2025-01-01"));
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read(rel), text);
    assert!(
        !f.facts()
            .iter()
            .any(|fact| matches!(fact, Applied::Renamed { .. }))
    );
}

/// Pulled tags reach the block, the file it replaces is kept as a version first (even as the
/// run's own last write), and the tags fact follows.
#[test]
fn a_version_is_kept_before_pulled_tags_rewrite_the_block() {
    let mut f = fixture();
    let text = "---\ntags:\n  - old\n---\nfirst words\n";
    let id = note(&mut f, text);
    f.own_files.wrote_back(&id, &content_hash(text));
    pulled_tags(&f, &id, &["remote"]);
    let outcome = f.run(&id);
    let Outcome::Wrote { version_kept, .. } = outcome else {
        panic!("no write: {outcome:?}");
    };
    assert!(version_kept);
    assert_eq!(f.versions(&id).last().map(String::as_str), Some(text));
    assert_eq!(f.read("n.md"), "---\ntags:\n  - remote\n---\nfirst words\n");
    let facts = f.facts();
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Changed {
                source: ChangeSource::Sync,
                ..
            }
        )),
        "{facts:?}"
    );
    assert!(
        facts
            .iter()
            .any(|fact| matches!(fact, Applied::TagsPulled { .. })),
        "{facts:?}"
    );
}

/// Tags that differ only in case are the same set: the file is not rewritten.
#[test]
fn tags_that_differ_in_case_only_leave_the_file() {
    let mut f = fixture();
    let text = "---\ntags:\n  - Remote\n---\nfirst words\n";
    let id = note(&mut f, text);
    pulled_tags(&f, &id, &["remote"]);
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("n.md"), text);
}

/// A key the record holds as the file does (a nested map the consumer read in) and the cover
/// keys, which the property read never takes, stay as the file holds them when pulled tags
/// rewrite the block.
#[test]
fn keys_the_record_does_not_hold_are_kept() {
    let mut f = fixture();
    let text = "---\nsource:\n  site: web\n  depth: 2\ncover: covers/a.png\n---\nfirst words\n";
    let id = note(&mut f, text);
    let read = text_values(text, &f.pass.property_types()).expect("a block");
    assert!(read.contains_key("source") && !read.contains_key("cover"));
    f.writer.file_properties(&id, Map::new(), read).unwrap();
    pulled_tags(&f, &id, &["remote"]);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    let file = f.read("n.md");
    assert!(
        file.contains("source:\n  site: web\n  depth: 2\n"),
        "{file:?}"
    );
    assert!(file.contains("cover: covers/a.png\n"), "{file:?}");
    assert!(file.contains("tags:\n  - remote\n"), "{file:?}");
}

/// A pulled property value reaches the root of the block.
#[test]
fn a_pulled_property_reaches_the_block() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled(&f, &id, |w| {
        w.set_property(id.clone(), "status".into(), "\"done\"".into())
            .unwrap();
    });
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(f.read("n.md"), "---\nstatus: done\n---\nfirst words\n");
}

/// A file named apart from its title (Electron numbers a taken name: `Untitled 1.md` titled
/// `Untitled`) keeps its name on a pulled change that keeps the title (`titleChanged`).
#[test]
fn a_pulled_change_that_keeps_the_title_keeps_a_numbered_name() {
    let mut f = fixture();
    let id = f.writer.create("Untitled".into(), None).unwrap();
    f.seed(&id, "Untitled 1.md", "first words\n");
    pulled_tags(&f, &id, &["remote"]);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert!(!f.root.join("Untitled.md").exists());
    assert_eq!(
        f.read("Untitled 1.md"),
        "---\ntags:\n  - remote\n---\nfirst words\n"
    );
    assert_eq!(row_path(&f, &id), "Untitled 1.md");
    assert_eq!(renamed_facts(&mut f), 0);
}

/// A pulled folder alone moves the file under its name byte for byte, `Moved`.
#[test]
fn a_pulled_folder_moves_the_file_under_its_own_name() {
    let mut f = fixture();
    let id = f.writer.create("Untitled".into(), None).unwrap();
    f.seed(&id, "Untitled 1.md", "first words\n");
    std::fs::create_dir(f.root.join("Work")).unwrap();
    pulled_folder(&f, &id, "Work");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("Work/Untitled 1.md"), "first words\n");
    assert!(!f.root.join("Untitled 1.md").exists());
    assert_eq!(row_path(&f, &id), "Work/Untitled 1.md");
    let facts = f.facts();
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Renamed { new_path, kind: MoveKind::Moved, .. } if new_path == "Work/Untitled 1.md"
        )),
        "{facts:?}"
    );
}

/// A pulled title renames the numbered file: the title changed.
#[test]
fn a_pulled_title_renames_a_numbered_file() {
    let mut f = fixture();
    let id = f.writer.create("Untitled".into(), None).unwrap();
    f.seed(&id, "Untitled 1.md", "first words\n");
    pulled_rename(&f, &id, "Plan");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("Plan.md"), "first words\n");
    assert_eq!(row_path(&f, &id), "Plan.md");
}

/// A pulled place that would make the note a journal day's file keeps it where it is.
#[test]
fn a_place_that_names_a_journal_day_keeps_the_file() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    std::fs::create_dir(f.root.join("journal")).unwrap();
    pulled(&f, &id, |w| {
        w.rename(id.clone(), "2025-01-02".into()).unwrap();
        w.move_to_folder(id.clone(), Some("journal".into()))
            .unwrap();
    });
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("n.md"), "first words\n");
    assert!(!f.root.join("journal/2025-01-02.md").exists());
    assert_eq!(row_path(&f, &id), "n.md");
}

/// A move that cannot happen never holds the file back from the note's edits: the body is
/// written at the file's path, the row and the file agree, and the move is tried by at most
/// `PLACE_TRIES` passes.
#[cfg(unix)]
#[test]
fn a_failed_move_still_writes_the_body_where_the_file_is() {
    use std::os::unix::fs::PermissionsExt;

    use crate::vault::writeback::place::PLACE_TRIES;

    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    let work = f.root.join("Work");
    std::fs::create_dir(&work).unwrap();
    std::fs::set_permissions(&work, std::fs::Permissions::from_mode(0o555)).unwrap();
    pulled_folder(&f, &id, "Work");
    for pass in 1..=PLACE_TRIES {
        f.edit_in_app(&id, &format!("typed {pass}"));
        let outcome = f.run(&id);
        assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
        assert!(f.read("n.md").contains(&format!("typed {pass}")));
        assert_eq!(row_path(&f, &id), "n.md");
        assert!(!work.join("n.md").exists());
    }
    // The tries are spent: a writable folder no longer moves the file on a local pass.
    std::fs::set_permissions(&work, std::fs::Permissions::from_mode(0o755)).unwrap();
    f.edit_in_app(&id, "typed after");
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert!(f.read("n.md").contains("typed after"));
    assert!(!work.join("n.md").exists());
}

/// A move that failed once is tried again by the next pass.
#[cfg(unix)]
#[test]
fn a_failed_move_is_tried_again() {
    use std::os::unix::fs::PermissionsExt;

    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    let work = f.root.join("Work");
    std::fs::create_dir(&work).unwrap();
    std::fs::set_permissions(&work, std::fs::Permissions::from_mode(0o555)).unwrap();
    pulled_folder(&f, &id, "Work");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    std::fs::set_permissions(&work, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("Work/n.md"), "first words\n");
    assert_eq!(row_path(&f, &id), "Work/n.md");
}

/// A pass that finds no file drops the mark: the file the consumer finds later is never moved
/// by a local pass.
#[test]
fn a_pass_with_no_file_drops_the_mark() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    std::fs::rename(f.root.join("n.md"), f.root.join("aside")).unwrap();
    assert_eq!(f.run(&id), Outcome::Kept(Keep::NoFile));
    std::fs::rename(f.root.join("aside"), f.root.join("n.md")).unwrap();
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("n.md"), "first words\n");
    assert!(!f.root.join("Renamed.md").exists());
}

/// A row not read yet keeps the mark, as a changed file does: the pass after the read places
/// the file.
#[test]
fn a_row_not_read_yet_keeps_the_mark() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    let hash = f.hash_of("n.md");
    f.record(&id, "n.md", None);
    assert_eq!(f.run(&id), Outcome::Kept(Keep::NotRead));
    f.record(&id, "n.md", hash);
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("Renamed.md"), "first words\n");
}

/// A pass kept for a server body not pulled yet keeps the mark (#5509): the pass after the body
/// arrives gives the file the pulled frontmatter, as Electron's `applyUpsert` writes it.
#[test]
fn a_pass_kept_for_its_unpulled_body_keeps_the_mark() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled(&f, &id, |w| {
        w.set_property(id.clone(), "status".into(), "\"done\"".into())
            .unwrap();
    });
    f.owe_server_body(&id);
    assert_eq!(f.run(&id), Outcome::Kept(Keep::BodyNotPulled));
    assert_eq!(
        f.read("n.md"),
        "first words\n",
        "the file waits for the body"
    );

    f.sql("DELETE FROM meta WHERE key = 'sync.body_owed:' || ?1", &id);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(f.read("n.md"), "---\nstatus: done\n---\nfirst words\n");
}

/// A note deleted under its pass (after the move, before the body read) drops its mark
/// (`Keep::NoNote`, REVIEW-5517 finding 4): a note that comes back is pulled again, never
/// patched by a mark with a stale `title_before`.
#[test]
fn a_note_deleted_under_its_pass_drops_the_mark() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled(&f, &id, |w| {
        w.rename(id.clone(), "Renamed".into()).unwrap();
        w.set_tags(id.clone(), vec!["pulled".into()]).unwrap();
    });
    // The move updates the row; the trigger deletes the note before the pass reads its body.
    f.exec(
        "CREATE TRIGGER gone_under_pass AFTER UPDATE OF path ON note_files
         BEGIN UPDATE notes SET deleted_at = 1 WHERE id = NEW.note_id; END",
    );
    assert_eq!(f.run(&id), Outcome::Kept(Keep::NoNote));
    f.exec("DROP TRIGGER gone_under_pass");
    f.sql("UPDATE notes SET deleted_at = NULL WHERE id = ?1", &id);
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(
        f.read("Renamed.md"),
        "first words\n",
        "no mark wrote the tags"
    );
}

/// A pulled place whose moves are given up still gives the file the pulled frontmatter once the
/// body is here: the mark waits through every pass kept for the body (REVIEW-5517 finding 3).
#[cfg(unix)]
#[test]
fn a_mark_whose_moves_failed_still_waits_for_the_body() {
    use std::os::unix::fs::PermissionsExt;

    use crate::vault::writeback::place::PLACE_TRIES;

    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    let work = f.root.join("Work");
    std::fs::create_dir(&work).unwrap();
    std::fs::set_permissions(&work, std::fs::Permissions::from_mode(0o555)).unwrap();
    pulled(&f, &id, |w| {
        w.move_to_folder(id.clone(), Some("Work".into())).unwrap();
        w.set_property(id.clone(), "status".into(), "\"done\"".into())
            .unwrap();
    });
    f.owe_server_body(&id);
    for _ in 0..=PLACE_TRIES {
        assert_eq!(f.run(&id), Outcome::Kept(Keep::BodyNotPulled));
    }
    std::fs::set_permissions(&work, std::fs::Permissions::from_mode(0o755)).unwrap();
    f.sql("DELETE FROM meta WHERE key = 'sync.body_owed:' || ?1", &id);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(f.read("n.md"), "---\nstatus: done\n---\nfirst words\n");
    assert!(
        !work.join("n.md").exists(),
        "the given-up move stays given up"
    );
}

/// A pull that marks the note while a pass holds its aliases-only mark keeps its full mark when
/// that pass gives the aliases-only one back (VERIFY-5808R4 finding 2, #5316).
#[test]
fn a_pull_mark_made_during_a_pass_outlives_the_aliases_only_mark_put_back() {
    let pulled = crate::vault::writeback::place::Pulled::default();
    pulled.mark_in_place("n");
    let held = pulled.take("n").expect("the aliases-only mark");
    assert!(held.aliases_only);
    pulled.mark("n", Some("Before"));
    pulled.put_back("n", held);
    let left = pulled.take("n").expect("a mark for the next pass");
    assert!(!left.aliases_only);
    assert_eq!(left.title_before.as_deref(), Some("Before"));
}

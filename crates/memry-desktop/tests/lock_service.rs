//! The desktop lock guard (Step 14e-2b, Electron `vault-locks/{registry,files,service}.ts`) over a
//! real session, tier, watcher, `data.db` and vault files:
//! - a rename, move, delete or create that would change a locked note or folder is refused as
//!   `note_locked` or `folder_locked` with Electron's text, before anything is written: the
//!   files, the rows and their hashes stay as they were;
//! - each open makes every locked file read-only, its attachments too, and records a locked
//!   note's text; after an unlock the next open gives each file its recorded bits back;
//! - a copied vault's records follow its new files, and a file replaced from outside never gets
//!   more than it had.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use memry_core::domain::vault_locks::TargetKind;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::error::{FailureKind, map_core};
use memry_desktop::journal::write::NewDay;
use memry_desktop::locks;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::VaultConfigPatch;
use memry_desktop::vault::config::settings::{SettingsError, update_vault_settings};
use serde_json::json;

use crate::notes_folder_move::note;
use crate::notes_link_rewrite::{id_at, opened, row_hash};
use crate::vault_env::{Env, env, indexed};
use crate::vault_settings::{opened_keeping, stored};

const NOTE: &str = "The body.\n";

fn lock(e: &Env, kind: TargetKind, target: &str) {
    e.core().locks().set(kind, target, true).unwrap();
}

fn unlock(e: &Env, kind: TargetKind, target: &str) {
    e.core().locks().set(kind, target, false).unwrap();
}

fn assert_refused(refused: Result<impl std::fmt::Debug, NotesError>, code: &str) {
    let error = refused.expect_err("the lock refuses it");
    let failure = map_core(&error);
    assert_eq!((failure.kind, failure.code), (FailureKind::Locked, code));
    let message = match code {
        "note_locked" => "The owner made this note read-only.",
        _ => "The owner made this folder read-only.",
    };
    assert_eq!(failure.message, message);
}

/// The test's trash: refuses, so a delete the lock let through fails and leaves the disk.
fn no_trash(_: &Path) -> Result<(), String> {
    Err("no trash in this test".into())
}

fn read_only(e: &Env, rel: &str) -> bool {
    fs::metadata(e.vault.join(rel))
        .unwrap()
        .permissions()
        .readonly()
}

#[cfg(unix)]
fn mode(e: &Env, rel: &str) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(e.vault.join(rel))
        .unwrap()
        .permissions()
        .mode()
        & 0o777
}

#[cfg(unix)]
fn set_mode(e: &Env, rel: &str, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(e.vault.join(rel), fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn a_locked_note_is_not_renamed() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    lock(&e, TargetKind::Note, &plan);
    let hash = row_hash(&e, &plan);

    assert_refused(notes.rename(&open, &plan, "Renamed"), "note_locked");
    assert_eq!(e.read("Plan.md"), NOTE);
    assert!(!e.vault.join("Renamed.md").exists());
    assert_eq!(id_at(&e, "Plan.md"), plan);
    assert_eq!(row_hash(&e, &plan), hash);
}

#[test]
fn a_note_in_a_locked_folder_is_not_moved_out() {
    let (e, notes, _) = opened(&[("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    let old = id_at(&e, "Archive/Old.md");
    lock(&e, TargetKind::Folder, "Archive");

    assert_refused(notes.move_to_folder(&open, &old, ""), "note_locked");
    assert_eq!(e.read("Archive/Old.md"), NOTE);
    assert!(!e.vault.join("Old.md").exists());
    assert_eq!(id_at(&e, "Archive/Old.md"), old);
}

#[test]
fn no_note_is_moved_into_a_locked_folder() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE), ("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    lock(&e, TargetKind::Folder, "Archive");

    assert_refused(
        notes.move_to_folder(&open, &plan, "Archive"),
        "folder_locked",
    );
    assert_eq!(e.read("Plan.md"), NOTE);
    assert!(!e.vault.join("Archive/Plan.md").exists());
    assert_eq!(id_at(&e, "Plan.md"), plan);
}

#[test]
fn a_locked_note_is_not_deleted() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    lock(&e, TargetKind::Note, &plan);
    let hash = row_hash(&e, &plan);

    assert_refused(notes.delete(&open, &plan, true), "note_locked");
    assert_eq!(e.read("Plan.md"), NOTE);
    assert_eq!(row_hash(&e, &plan), hash);
    assert!(e.core().notes().metadata(plan.clone()).unwrap().is_some());
}

#[test]
fn no_note_is_created_in_a_locked_folder() {
    let (e, notes, _) = opened(&[("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "Archive");
    let rows = e.rows();

    assert_refused(notes.create(&open, note("New", "Archive")), "folder_locked");
    assert!(!e.vault.join("Archive/New.md").exists());
    assert_eq!(e.rows(), rows);
}

#[test]
fn no_folder_is_created_in_a_locked_folder() {
    let (e, notes, _) = opened(&[("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "Archive");

    assert_refused(notes.create_folder(&open, "Archive/Sub"), "folder_locked");
    assert!(!e.vault.join("Archive/Sub").exists());
}

#[test]
fn a_locked_folder_is_not_renamed() {
    let (e, notes, _) = opened(&[("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "Archive");

    assert_refused(
        notes.rename_folder(&open, "Archive", "Attic", |_| {}),
        "folder_locked",
    );
    assert_eq!(e.read("Archive/Old.md"), NOTE);
    assert!(!e.vault.join("Attic").exists());
}

#[test]
fn a_folder_holding_a_locked_note_is_not_moved() {
    let (e, notes, _) = opened(&[("Work/Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Work/Plan.md");
    lock(&e, TargetKind::Note, &plan);

    assert_refused(
        notes.rename_folder(&open, "Work", "Done", |_| {}),
        "folder_locked",
    );
    assert_eq!(e.read("Work/Plan.md"), NOTE);
    assert_eq!(id_at(&e, "Work/Plan.md"), plan);
}

#[test]
fn no_folder_is_moved_into_a_locked_folder() {
    let (e, notes, _) = opened(&[("Work/Plan.md", NOTE), ("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "Archive");

    assert_refused(
        notes.rename_folder(&open, "Work", "Archive/Work", |_| {}),
        "folder_locked",
    );
    assert_eq!(e.read("Work/Plan.md"), NOTE);
    assert!(!e.vault.join("Archive/Work").exists());
}

#[test]
fn a_folder_holding_a_lock_is_not_deleted() {
    let (e, _, store) = opened(&[("Work/Plan.md", NOTE), ("Work/Sub/Kept.md", NOTE)]);
    let notes = NotesService::with_trash(e.tier.clone(), store, no_trash);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "Work/Sub");

    assert_refused(notes.delete_folder(&open, "Work"), "folder_locked");
    assert_eq!(e.read("Work/Plan.md"), NOTE);
    assert_eq!(e.read("Work/Sub/Kept.md"), NOTE);
}

#[test]
fn no_journal_day_is_created_in_a_locked_journal_folder() {
    let (e, notes, _) = opened(&[("journal/2026-01-04.md", "Before.\n")]);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "journal");
    let rows = e.rows();

    let day = NewDay {
        date: "2026-01-05".into(),
        content: "Morning pages.".into(),
        ..NewDay::default()
    };
    assert_refused(notes.create_day(&open, day), "folder_locked");
    assert!(!e.vault.join("journal/2026-01-05.md").exists());
    assert_eq!(e.rows(), rows);
}

#[test]
fn a_locked_journal_day_is_not_deleted() {
    let (e, notes, _) = opened(&[]);
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: "2026-01-05".into(),
        content: "Morning pages.".into(),
        ..NewDay::default()
    };
    notes.create_day(&open, day).unwrap();
    let id = id_at(&e, "journal/2026-01-05.md");
    lock(&e, TargetKind::Note, &id);
    let text = e.read("journal/2026-01-05.md");

    assert_refused(notes.delete_day(&open, "2026-01-05"), "note_locked");
    assert_eq!(e.read("journal/2026-01-05.md"), text);
    assert_eq!(id_at(&e, "journal/2026-01-05.md"), id);
}

/// The caller's spelling of a folder is not the one the refusal reads: the operation lands on
/// the disk's (`folder_on_disk`), so `ARCHIVE` is the locked `Archive` on every volume.
#[test]
fn another_spelling_of_a_locked_folder_takes_no_note_moved_in() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE), ("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    lock(&e, TargetKind::Folder, "Archive");

    assert_refused(
        notes.move_to_folder(&open, &plan, "ARCHIVE"),
        "folder_locked",
    );
    assert_eq!(e.read("Plan.md"), NOTE);
    assert_eq!(id_at(&e, "Plan.md"), plan);
}

#[test]
fn another_spelling_of_a_locked_folder_is_not_renamed() {
    let (e, notes, _) = opened(&[("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "Archive");

    assert_refused(
        notes.rename_folder(&open, "ARCHIVE", "Attic", |_| {}),
        "folder_locked",
    );
    assert_eq!(e.read("Archive/Old.md"), NOTE);
    assert!(!e.vault.join("Attic").exists());
}

#[test]
fn another_spelling_of_a_locked_folder_takes_no_new_note() {
    let (e, notes, _) = opened(&[("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "Archive");
    let rows = e.rows();

    assert_refused(notes.create(&open, note("New", "ARCHIVE")), "folder_locked");
    assert!(!e.vault.join("Archive/New.md").exists());
    assert!(!e.vault.join("ARCHIVE/New.md").exists());
    assert_eq!(e.rows(), rows);
}

#[test]
fn a_folder_inside_a_locked_folder_is_not_deleted() {
    let (e, _, store) = opened(&[("Archive/Sub/Kept.md", NOTE)]);
    let notes = NotesService::with_trash(e.tier.clone(), store, no_trash);
    let open = e.session.current().unwrap();
    lock(&e, TargetKind::Folder, "Archive");

    assert_refused(notes.delete_folder(&open, "Archive/Sub"), "folder_locked");
    assert_eq!(e.read("Archive/Sub/Kept.md"), NOTE);
}

fn day_format(e: &Env, to: &str) -> Result<(), SettingsError> {
    let patch = VaultConfigPatch {
        journal_date_format: Some(to.to_owned()),
        ..VaultConfigPatch::default()
    };
    update_vault_settings(&e.vault, Some((&e.core(), &e.tier)), patch, |_| {
        panic!("announced")
    })
    .map(drop)
}

fn assert_format_refused(e: &Env, refused: Result<(), SettingsError>) {
    let error = refused.expect_err("the lock refuses the format");
    assert!(matches!(error, SettingsError::Locked), "{error:?}");
    assert_eq!(error.to_string(), "The owner made this note read-only.");
    assert_eq!(stored(&e.vault)["journalDateFormat"], "YYYY-MM-DD");
    assert_eq!(e.read("journal/2025-01-02.md"), "A day\n");
}

const JOURNAL: &str = "journal/2025-01-02.md";

/// Electron's format change refuses before it renames anything when a day is locked
/// (`journal-format-migration.ts`).
#[test]
fn a_date_format_change_leaves_a_locked_day_and_is_refused() {
    let config = json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" });
    let (e, _) = opened_keeping(
        config,
        &[(JOURNAL, "A day\n"), ("journal/2025-01-03.md", "B\n")],
    );
    lock(&e, TargetKind::Note, &id_at(&e, JOURNAL));

    assert_format_refused(&e, day_format(&e, "YYYY-MM-DD dddd"));
    assert_eq!(e.read("journal/2025-01-03.md"), "B\n", "no day renamed");
}

#[test]
fn a_date_format_change_moves_no_day_of_a_locked_journal_folder() {
    let config = json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" });
    let (e, _) = opened_keeping(config, &[(JOURNAL, "A day\n")]);
    lock(&e, TargetKind::Folder, "journal");

    assert_format_refused(&e, day_format(&e, "YYYY/YYYY-MM-DD"));
    assert!(!e.vault.join("journal/2025").exists());
}

#[test]
fn a_date_format_change_moves_no_day_into_a_locked_folder() {
    let config = json!({ "journalFolder": "journal", "journalDateFormat": "YYYY-MM-DD" });
    let (e, _) = opened_keeping(config, &[(JOURNAL, "A day\n")]);
    lock(&e, TargetKind::Folder, "journal/2025");

    assert_format_refused(&e, day_format(&e, "YYYY/YYYY-MM-DD"));
}

/// An open vault over `files` whose opens run the lock guard, its first walk done.
fn guarded(files: &[(&str, &str)]) -> (Env, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    locks::register(&e.session);
    for (rel, text) in files {
        e.write(rel, text);
    }
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
    e.open();
    e.facts_until(indexed);
    (e, kept.expect("the store"))
}

fn reopen(e: &mut Env) {
    e.close();
    e.open();
    e.facts_until(indexed);
}

#[test]
fn an_open_makes_locked_files_read_only_and_an_unlock_gives_them_back() {
    let (mut e, _) = guarded(&[
        ("Plan.md", NOTE),
        ("Archive/Old.md", NOTE),
        ("Free.md", NOTE),
    ]);
    let plan = id_at(&e, "Plan.md");
    let picture = format!("attachments/{plan}/a1b2c3-pic.png");
    e.write(&picture, "png bytes");
    #[cfg(unix)]
    set_mode(&e, "Plan.md", 0o640);
    lock(&e, TargetKind::Note, &plan);
    lock(&e, TargetKind::Folder, "Archive");

    reopen(&mut e);
    for rel in ["Plan.md", "Archive/Old.md", picture.as_str()] {
        assert!(read_only(&e, rel), "{rel} is read-only");
    }
    assert!(!read_only(&e, "Free.md"));
    #[cfg(unix)]
    assert_eq!(mode(&e, "Plan.md"), 0o440);
    let baseline = e
        .core()
        .locks()
        .baseline(&plan)
        .unwrap()
        .expect("a baseline");
    assert_eq!(baseline.content, NOTE);

    unlock(&e, TargetKind::Note, &plan);
    unlock(&e, TargetKind::Folder, "Archive");
    reopen(&mut e);
    for rel in ["Plan.md", "Archive/Old.md", picture.as_str()] {
        assert!(!read_only(&e, rel), "{rel} is writable again");
    }
    #[cfg(unix)]
    assert_eq!(mode(&e, "Plan.md"), 0o640, "its own bits, not more");
    let store = e.core().locks();
    assert_eq!(store.file_modes().unwrap(), vec![]);
    assert_eq!(store.baseline_note_ids().unwrap(), Vec::<String>::new());
}

#[test]
fn a_copied_vault_unlocks_its_files_to_their_recorded_bits() {
    let (mut e, _) = guarded(&[("Plan.md", NOTE)]);
    let plan = id_at(&e, "Plan.md");
    #[cfg(unix)]
    set_mode(&e, "Plan.md", 0o640);
    lock(&e, TargetKind::Note, &plan);
    reopen(&mut e);
    assert!(read_only(&e, "Plan.md"));
    e.close();

    // Every file of the copy is another file than the one its record names.
    let copy = e.vault.with_file_name("copy");
    copy_tree(&e.vault, &copy);
    e.vault = copy;
    e.open();
    e.facts_until(indexed);
    assert!(read_only(&e, "Plan.md"));
    unlock(&e, TargetKind::Note, &plan);
    reopen(&mut e);

    assert!(!read_only(&e, "Plan.md"));
    #[cfg(unix)]
    assert_eq!(mode(&e, "Plan.md"), 0o640);
}

/// A locked file replaced from outside by another read-only file: its bits are what an unlock
/// gives back, never the replaced file's.
#[cfg(unix)]
#[test]
fn a_file_replaced_from_outside_gets_back_only_the_bits_it_came_with() {
    let (mut e, _) = guarded(&[("Plan.md", NOTE)]);
    let plan = id_at(&e, "Plan.md");
    set_mode(&e, "Plan.md", 0o644);
    lock(&e, TargetKind::Note, &plan);
    reopen(&mut e);
    assert_eq!(mode(&e, "Plan.md"), 0o444);
    e.close();

    fs::remove_file(e.vault.join("Plan.md")).unwrap();
    fs::write(e.vault.join("Plan.md"), NOTE).unwrap();
    set_mode(&e, "Plan.md", 0o400);
    e.open();
    e.facts_until(indexed);
    unlock(&e, TargetKind::Note, &plan);
    reopen(&mut e);

    assert_eq!(mode(&e, "Plan.md"), 0o400);
}

/// The app's own write replaces a locked file (a new inode) and keeps its record, re-keyed to the
/// new file: an unlock after the next open gives the bits back. Two locked files, so a copied
/// vault's adoption (all or none) cannot stand in for the re-key.
#[cfg(unix)]
#[test]
fn a_locked_file_the_app_wrote_unlocks_to_its_recorded_bits() {
    let (mut e, _) = guarded(&[("Plan.md", NOTE), ("Other.md", NOTE)]);
    let (plan, other) = (id_at(&e, "Plan.md"), id_at(&e, "Other.md"));
    set_mode(&e, "Plan.md", 0o640);
    lock(&e, TargetKind::Note, &plan);
    lock(&e, TargetKind::Note, &other);
    reopen(&mut e);
    assert_eq!(mode(&e, "Plan.md"), 0o440);

    {
        let open = e.session.current().unwrap();
        let path = e.vault.join("Plan.md");
        locks::Locks::of(&open)
            .write_through("Plan.md", NOTE, || {
                let aside = e.vault.join(".Plan.md.tmp");
                fs::write(&aside, NOTE)?;
                fs::rename(&aside, &path)
            })
            .unwrap();
    }
    assert_eq!(mode(&e, "Plan.md"), 0o440);
    reopen(&mut e);
    unlock(&e, TargetKind::Note, &plan);
    reopen(&mut e);

    assert_eq!(mode(&e, "Plan.md"), 0o640);
}

/// Copies `from` to `to`, files and folders, every file a new one with its permissions.
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

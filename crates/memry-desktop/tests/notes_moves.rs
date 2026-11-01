//! A note renamed or moved in the app (Step 13g, #3530) under the running vault tier: the move
//! is recorded before the file moves, the file moves with its bytes, the record, row and slot
//! follow it, one `Renamed` fact goes out, and the watcher reports none of it back as a delete
//! and a new note. A step that fails puts the file back and forgets the record. The vault
//! open's finish of a move a crash cut short is `vault_app_move_open.rs`.

mod device_key;
mod vault_env;

use std::fs;
use std::sync::Arc;

use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::notes::app_move::{AppMoved, BeginError, PendingMove, Recorded};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::moves::MoveTo;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::activity::ActivityFilter;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use vault_env::{Env, QUIET, env, indexed};

/// An open vault with its first walk done, the notes service over its tier, and its store.
fn opened() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

fn note(title: &str, folder: &str) -> NewNoteFile {
    NewNoteFile {
        title: title.into(),
        content: format!("About {title}"),
        folder: Some(folder.into()),
        ..NewNoteFile::default()
    }
}

/// A file note (no step makes one yet; attachments will): `bytes` at `rel`, a record and a
/// row with no hash, as a PDF's row is. The vault opens again so the tier knows the row.
fn file_note(e: &mut Env, store: &Arc<dyn SecureStore>, rel: &str, bytes: &[u8]) -> String {
    let title = rel.trim_end_matches(".pdf");
    fs::write(e.vault.join(rel), bytes).unwrap();
    let core = e.core();
    let id = core
        .notes_writer(store.clone())
        .unwrap()
        .create(title.into(), None)
        .unwrap();
    core.note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.clone(),
            path: rel.into(),
            file_type: "pdf".into(),
            mime_type: Some("application/pdf".into()),
            file_size: Some(bytes.len() as i64),
            content_hash: None,
            file_hash: None,
            indexed_at: 0,
        })
        .unwrap();
    drop(core);
    e.close();
    e.open();
    e.facts_until(indexed);
    id
}

/// The rows `sql` selects with `arg` as `?1`, each read by `read`.
fn query<T: Send + 'static>(
    e: &Env,
    sql: &'static str,
    arg: &str,
    read: fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Vec<T> {
    let arg = arg.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let mut statement = conn.prepare(sql).unwrap();
            let rows = statement.query_map([arg], read).unwrap();
            Ok(rows.collect::<Result<Vec<_>, _>>().unwrap())
        })
        .unwrap()
}

/// `(title, folder, deleted)` of the record.
fn record(e: &Env, id: &str) -> (String, Option<String>, bool) {
    let sql = "SELECT title, folder_path, deleted_at IS NOT NULL FROM notes WHERE id = ?1";
    query(e, sql, id, |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
    .remove(0)
}

fn note_count(e: &Env) -> i64 {
    query(e, "SELECT COUNT(*) FROM notes WHERE ?1 = ''", "", |row| {
        row.get(0)
    })[0]
}

fn slot(e: &Env, path: &str) -> Option<i64> {
    let sql = "SELECT position FROM note_positions WHERE path = ?1";
    query(e, sql, path, |row| row.get(0)).pop()
}

/// `paths` become the hand-made order of `folder`.
fn order(e: &Env, folder: &str, paths: &[&str]) {
    let folder = folder.to_owned();
    let paths: Vec<String> = paths.iter().map(|path| (*path).to_owned()).collect();
    let insert = "INSERT INTO note_positions (path, folder_path, position) VALUES (?1, ?2, ?3)";
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            for (position, path) in (0_i64..).zip(&paths) {
                conn.execute(insert, rusqlite::params![path, folder, position])
                    .unwrap();
            }
            Ok(())
        })
        .unwrap();
}

/// The app moves recorded and not finished or forgotten.
fn pending(e: &Env, store: &Arc<dyn SecureStore>) -> Vec<(String, Recorded)> {
    let writer = e.core().notes_writer(store.clone()).unwrap();
    writer.pending_app_moves().unwrap()
}

/// The row facts once the watcher had time to report what the app did, but the app's own
/// writes of a body: a watcher fact among them is the app's move taken for an outside one.
fn row_facts(e: &mut Env) -> Vec<Applied> {
    std::thread::sleep(QUIET);
    e.drain()
        .into_iter()
        .filter(|fact| {
            matches!(
                fact,
                Applied::Changed {
                    source: ChangeSource::Watcher,
                    ..
                } | Applied::Added { .. }
                    | Applied::Removed { .. }
                    | Applied::Renamed { .. }
            )
        })
        .collect()
}

fn renamed(id: &str, old: &str, new: &str) -> Applied {
    Applied::Renamed {
        note_id: id.to_owned(),
        old_path: old.to_owned(),
        new_path: new.to_owned(),
    }
}

fn names_in(e: &Env, folder: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(e.vault.join(folder))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    names
}

#[test]
fn a_rename_moves_the_file_and_the_note_keeps_its_id_title_and_slot() {
    let (mut e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("Plan", "work")).unwrap();
    let bytes = e.read("work/Plan.md");
    notes.create(&open, note("Other", "work")).unwrap();
    order(&e, "work", &["work/Other.md", "work/Plan.md"]);
    e.drain();

    // `:` is a character no file name holds; the title keeps it. Once the file moved, before
    // the record follows, the move is on record for an open after a crash to finish.
    let mut seen = None;
    let renamed_note = notes
        .move_checked(&open, &made.id, MoveTo::Title("Plan: Q3"), &mut || {
            seen = Some((
                e.vault.join("work/Plan Q3.md").exists(),
                pending(&e, &store),
            ));
            Ok(())
        })
        .unwrap();
    let recorded = Recorded::Move(PendingMove {
        old_path: "work/Plan.md".into(),
        new_path: "work/Plan Q3.md".into(),
        title: Some("Plan: Q3".into()),
    });
    assert_eq!(seen, Some((true, vec![(made.id.clone(), recorded)])));
    assert_eq!(
        (renamed_note.id.as_str(), renamed_note.path.as_str()),
        (made.id.as_str(), "work/Plan Q3.md")
    );
    assert_eq!(renamed_note.title, "Plan: Q3");
    assert_eq!(names_in(&e, "work"), ["Other.md", "Plan Q3.md"]);
    assert_eq!(
        e.read("work/Plan Q3.md"),
        bytes,
        "a rename changed the bytes"
    );
    assert_eq!(
        record(&e, &made.id),
        ("Plan: Q3".into(), Some("work".into()), false)
    );
    assert_eq!(slot(&e, "work/Plan Q3.md"), Some(1));
    assert_eq!(slot(&e, "work/Plan.md"), None);
    assert_eq!(pending(&e, &store), []);
    assert_eq!(
        row_facts(&mut e),
        [renamed(&made.id, "work/Plan.md", "work/Plan Q3.md")]
    );
    assert_eq!(note_count(&e), 2);
    let activity = e.tier.activity().list(100, ActivityFilter::All).entries;
    assert!(
        activity.is_empty(),
        "the watcher reported the app's rename: {activity:?}"
    );

    // The file at its new name is still the note's: an outside edit changes it.
    fs::write(e.vault.join("work/Plan Q3.md"), "Edited elsewhere\n").unwrap();
    e.facts_until(|fact| {
        matches!(fact, Applied::Changed { note_id, source: ChangeSource::Watcher, .. }
            if *note_id == made.id)
    });
    assert_eq!(e.body(&made.id), "Edited elsewhere");
}

#[test]
fn a_move_keeps_the_name_unless_taken_and_tops_the_new_folder() {
    let (mut e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("Plan", "work")).unwrap();
    notes.create(&open, note("Plan", "")).unwrap();
    notes.create(&open, note("Root", "")).unwrap();
    order(&e, "work", &["work/Plan.md"]);
    order(&e, "", &["Root.md", "Plan.md"]);
    let bytes = e.read("work/Plan.md");
    e.drain();

    let moved = notes.move_to_folder(&open, &made.id, "").unwrap();
    assert_eq!(moved.path, "Plan 1.md");
    assert_eq!(moved.title, "Plan");
    assert_eq!(e.read("Plan 1.md"), bytes);
    assert!(!e.vault.join("work/Plan.md").exists());
    assert_eq!(record(&e, &made.id), ("Plan".into(), None, false));
    // Above every placed note of the root, as a new note there would be.
    assert_eq!(slot(&e, "Plan 1.md"), Some(-1));
    assert_eq!(slot(&e, "work/Plan.md"), None);
    assert_eq!(
        row_facts(&mut e),
        [renamed(&made.id, "work/Plan.md", "Plan 1.md")]
    );

    // Into a folder that is not there yet, which the move makes; empty and `.` segments go.
    let deeper = notes.move_to_folder(&open, &made.id, "a//./b/").unwrap();
    assert_eq!(deeper.path, "a/b/Plan 1.md");
    assert_eq!(record(&e, &made.id).1.as_deref(), Some("a/b"));
}

/// On a volume that folds case the new name is the old file; it is respelled in place, never
/// numbered past itself (Electron's `generateUniquePath` gives `Plan 1.md` there; the respelling
/// is a deliberate divergence). On one that does not it is a plain rename. Either way the
/// watcher takes it for no delete and no new note: the one fact is the app's `Renamed`.
#[test]
fn a_rename_that_changes_only_case_respells_the_file() {
    let (mut e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("plan", "work")).unwrap();
    e.drain();

    let renamed_note = notes.rename(&open, &made.id, "Plan").unwrap();
    assert_eq!(renamed_note.path, "work/Plan.md");
    assert_eq!(renamed_note.title, "Plan");
    assert_eq!(names_in(&e, "work"), ["Plan.md"]);
    assert_eq!(e.rows(), [(made.id.clone(), "work/Plan.md".to_owned())]);
    assert_eq!(
        row_facts(&mut e),
        [renamed(&made.id, "work/plan.md", "work/Plan.md")]
    );
    assert_eq!(note_count(&e), 1);
}

#[test]
fn a_folder_the_vault_would_lose_the_note_in_is_refused() {
    let (e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("Plan", "work")).unwrap();
    let windows_only: &[&str] = if cfg!(windows) {
        &["a:b", "a\\b", "x."]
    } else {
        &[]
    };
    for folder in [".git", "attachments", "a/../b", "/.."]
        .iter()
        .chain(windows_only)
    {
        let refused = notes.move_to_folder(&open, &made.id, folder);
        assert!(
            matches!(refused, Err(NotesError::InvalidFolder)),
            "{folder}: {refused:?}"
        );
    }
    #[cfg(unix)]
    {
        fs::create_dir_all(e.vault.join("real")).unwrap();
        std::os::unix::fs::symlink(e.vault.join("real"), e.vault.join("linked")).unwrap();
        let refused = notes.move_to_folder(&open, &made.id, "linked");
        assert!(
            matches!(refused, Err(NotesError::InvalidFolder)),
            "{refused:?}"
        );
    }
    // A file where a folder of the path should be: no folder can be made there.
    e.write("taken", "a file\n");
    for folder in ["taken", "taken/deeper"] {
        let refused = notes.move_to_folder(&open, &made.id, folder);
        assert!(
            matches!(refused, Err(NotesError::InvalidFolder)),
            "{folder}: {refused:?}"
        );
    }
    let empty = notes.rename(&open, &made.id, "");
    assert!(matches!(empty, Err(NotesError::InvalidTitle)), "{empty:?}");
    assert_eq!(e.rows(), [(made.id.clone(), "work/Plan.md".to_owned())]);
    assert!(e.vault.join("work/Plan.md").exists());
    assert_eq!(pending(&e, &store), []);

    // A name the user's own file system holds is a folder of the vault (`is_plain_relative`).
    #[cfg(unix)]
    {
        let moved = notes.move_to_folder(&open, &made.id, "Re: plan ").unwrap();
        assert_eq!(moved.path, "Re: plan /Plan.md");
    }
}

/// A file note (PDF, image) is renamed and moved as a markdown note is, though its row has no
/// hash: the record of the move, not the bytes, is what a crash is settled by.
#[test]
fn a_file_note_is_renamed_and_moved_like_a_markdown_note() {
    let (mut e, notes, store) = opened();
    let id = file_note(&mut e, &store, "scan.pdf", b"%PDF-1.4\n");
    let open = e.session.current().unwrap();
    e.drain();

    let renamed_note = notes.rename(&open, &id, "Scan: March").unwrap();
    assert_eq!(renamed_note.path, "Scan March.pdf");
    assert_eq!(
        fs::read(e.vault.join("Scan March.pdf")).unwrap(),
        b"%PDF-1.4\n"
    );
    assert!(!e.vault.join("scan.pdf").exists());
    assert_eq!(record(&e, &id), ("Scan: March".into(), None, false));
    let moved = notes.move_to_folder(&open, &id, "docs").unwrap();
    assert_eq!(moved.path, "docs/Scan March.pdf");
    assert_eq!(e.rows(), [(id.clone(), "docs/Scan March.pdf".to_owned())]);
    assert_eq!(
        row_facts(&mut e),
        [
            renamed(&id, "scan.pdf", "Scan March.pdf"),
            renamed(&id, "Scan March.pdf", "docs/Scan March.pdf"),
        ]
    );
    assert_eq!(pending(&e, &store), []);
    assert_eq!(note_count(&e), 1);
}

/// A file whose name a new note would not get (over a new name's 240 bytes, or a Windows device
/// name, which Windows itself cannot hold) keeps it when the note is renamed to the title that
/// name says. A title the file's name already spells another way moves nothing either, and its
/// `Renamed` names the one path.
#[test]
fn a_rename_to_the_title_the_file_already_says_moves_nothing() {
    let (mut e, notes, _) = opened();
    let long = "\u{4e00}".repeat(82);
    let stems = [Some(long.as_str()), cfg!(not(windows)).then_some("con")];
    for stem in stems.into_iter().flatten() {
        let rel = format!("{stem}.md");
        e.write(&rel, "Kept\n");
        let facts =
            e.facts_until(|fact| matches!(fact, Applied::Added { path, .. } if *path == rel));
        let Some(Applied::Added { note_id, .. }) = facts.last() else {
            unreachable!()
        };
        let open = e.session.current().unwrap();

        let renamed_note = notes.rename(&open, note_id, stem).unwrap();
        assert_eq!(renamed_note.path, rel);
        assert!(e.vault.join(&rel).exists());
        assert_eq!(row_facts(&mut e), []);
    }

    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("ab", "")).unwrap();
    e.drain();
    let renamed_note = notes.rename(&open, &made.id, "a/b").unwrap();
    assert_eq!(
        (renamed_note.path.as_str(), renamed_note.title.as_str()),
        ("ab.md", "a/b")
    );
    assert_eq!(row_facts(&mut e), [renamed(&made.id, "ab.md", "ab.md")]);
}

#[test]
fn a_record_that_cannot_follow_puts_the_file_back() {
    let (mut e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("Plan", "work")).unwrap();
    e.drain();

    let failed = notes.move_checked(&open, &made.id, MoveTo::Title("Later"), &mut || {
        Err(NotesError::Io(std::io::Error::other("injected")))
    });
    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert_eq!(names_in(&e, "work"), ["Plan.md"]);
    assert_eq!(e.rows(), [(made.id.clone(), "work/Plan.md".to_owned())]);
    assert_eq!(record(&e, &made.id).0, "Plan");
    assert_eq!(
        row_facts(&mut e),
        [],
        "the watcher took the move and its undo for its own"
    );
    assert_eq!(note_count(&e), 1);
    assert_eq!(
        pending(&e, &store),
        [],
        "the record of the undone move stayed"
    );

    // The next move is not held back by a record of this one.
    assert_eq!(
        notes.rename(&open, &made.id, "Later").unwrap().path,
        "work/Later.md"
    );
}

/// A note whose last move is still on record (a crash the open could not settle) does not
/// move again: its file may be at either path.
#[test]
fn a_note_with_an_unsettled_move_is_not_moved() {
    let (e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("Plan", "work")).unwrap();
    let moved = AppMoved {
        old_path: "work/Plan.md",
        new_path: "work/Elsewhere.md",
        title: Some("Elsewhere"),
        keeps_kind: true,
    };
    e.core()
        .notes_writer(store.clone())
        .unwrap()
        .begin_app_move(&made.id, moved)
        .unwrap();

    let refused = notes.rename(&open, &made.id, "Later");
    assert!(
        matches!(refused, Err(NotesError::MovePending(BeginError::Unsettled))),
        "{refused:?}"
    );
    assert_eq!(names_in(&e, "work"), ["Plan.md"]);
    assert_eq!(e.rows(), [(made.id.clone(), "work/Plan.md".to_owned())]);
    assert_eq!(record(&e, &made.id).0, "Plan");
}

/// A file the volume will not move (a folder it may not write) stays, and so does no record of
/// the move for the next open to act on.
#[cfg(unix)]
#[test]
fn a_file_that_cannot_move_leaves_no_record_of_the_move() {
    use std::os::unix::fs::PermissionsExt as _;

    let (e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("Plan", "work")).unwrap();
    let locked = e.vault.join("locked");
    fs::create_dir_all(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
    // As root the folder takes the file anyway; the guard is then not this test's to see.
    if fs::write(locked.join("probe"), "").is_ok() {
        return;
    }

    let refused = notes.move_to_folder(&open, &made.id, "locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(refused, Err(NotesError::Io(_))), "{refused:?}");
    assert!(e.vault.join("work/Plan.md").exists());
    assert_eq!(e.rows(), [(made.id.clone(), "work/Plan.md".to_owned())]);
    assert_eq!(
        pending(&e, &store),
        [],
        "the record of a move that never ran stayed"
    );
}

/// A note moved into a journal day's path is not that day; the record stays and is owed the
/// move (Step 13m), and only the row follows the file.
#[test]
fn a_move_into_a_days_path_leaves_the_record_owed() {
    let (e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let made = notes.create(&open, note("2025-01-14", "work")).unwrap();

    let moved = notes.move_to_folder(&open, &made.id, "journal").unwrap();
    assert_eq!(moved.path, "journal/2025-01-14.md");
    assert_eq!(
        record(&e, &made.id),
        ("2025-01-14".into(), Some("work".into()), false)
    );
    let writer = e.core().notes_writer(store).unwrap();
    let owed = writer.owed_places().unwrap();
    assert_eq!(owed.len(), 1);
    assert_eq!(
        (owed[0].note_id.as_str(), owed[0].from_path.as_str()),
        (made.id.as_str(), "work/2025-01-14.md")
    );
}

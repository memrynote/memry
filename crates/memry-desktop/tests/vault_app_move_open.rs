//! The vault open's finish of the app moves a crash cut short (Step 13g, #3530), under the
//! running tier. Each test records moves in the core as the app does before it moves a file,
//! leaves the files as a crash would, and opens the vault: a move whose file got to its new
//! path is finished before the walk, one with nothing to finish is forgotten, and one the open
//! cannot settle, or cannot read, is logged and stays.

mod device_key;
mod vault_env;

use std::fs;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::notes::app_move::{AppMoved, record_key};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::consumer::Applied;
use rusqlite::OptionalExtension as _;
use vault_env::{Env, env, indexed};

/// An open vault under the notes identity, through its first walk, and its store.
fn opened() -> (Env, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    (e, kept.expect("the store"))
}

fn writer(e: &Env, store: &Arc<dyn SecureStore>) -> Arc<NotesWriter> {
    e.core().notes_writer(store.clone()).unwrap()
}

/// The note the watcher makes of a markdown file written at `rel`.
fn markdown_note(e: &mut Env, rel: &str) -> String {
    e.write(rel, "About it\n");
    let facts = e.facts_until(|fact| matches!(fact, Applied::Added { path, .. } if path == rel));
    let Some(Applied::Added { note_id, .. }) = facts.last() else {
        unreachable!()
    };
    note_id.clone()
}

/// A file note (no step makes one yet; attachments will): a record and a row with no hash, as
/// a PDF's row is. The tier learns the row at the next open.
fn file_note(e: &Env, store: &Arc<dyn SecureStore>, rel: &str, title: &str) -> String {
    fs::write(e.vault.join(rel), "%PDF-1.4\n").unwrap();
    let id = writer(e, store).create(title.into(), None).unwrap();
    e.core()
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.clone(),
            path: rel.into(),
            file_type: "pdf".into(),
            mime_type: Some("application/pdf".into()),
            file_size: Some(9),
            content_hash: None,
            file_hash: None,
            indexed_at: 0,
        })
        .unwrap();
    id
}

fn begin(e: &Env, store: &Arc<dyn SecureStore>, id: &str, old: &str, new: &str, title: &str) {
    let moved = AppMoved {
        old_path: old,
        new_path: new,
        title: Some(title),
        keeps_kind: true,
    };
    writer(e, store).begin_app_move(id, moved).unwrap();
}

/// Closes the vault, runs `between` on it closed, and opens it through its walk. `quiet`: the
/// walk must report no file added, removed or moved.
fn reopen(e: &mut Env, quiet: bool, between: impl FnOnce(&Env)) {
    e.close();
    e.drain();
    between(e);
    e.open();
    let found = e.facts_until(indexed);
    let reported = found.iter().find(|fact| {
        matches!(
            fact,
            Applied::Added { .. } | Applied::Removed { .. } | Applied::Renamed { .. }
        )
    });
    assert!(!quiet || reported.is_none(), "the walk saw {reported:?}");
}

fn rename(e: &Env, old: &str, new: &str) {
    fs::rename(e.vault.join(old), e.vault.join(new)).unwrap();
}

fn title(e: &Env, id: &str) -> String {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row("SELECT title FROM notes WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .unwrap())
        })
        .unwrap()
}

fn record(e: &Env, id: &str) -> Option<String> {
    let key = record_key(id);
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                    row.get(0)
                })
                .optional()
                .unwrap())
        })
        .unwrap()
}

fn row(e: &Env, id: &str) -> Option<String> {
    e.core().note_files().by_id(id).unwrap().map(|row| row.path)
}

/// Moves of several notes, interleaved and cut short at different steps, each converge.
#[test]
fn interrupted_moves_of_several_notes_each_converge_when_the_vault_opens() {
    let (mut e, store) = opened();
    let plan = markdown_note(&mut e, "Plan.md");
    let idea = markdown_note(&mut e, "Idea.md");
    let draft = markdown_note(&mut e, "Draft.md");
    begin(&e, &store, &plan, "Plan.md", "Plan Q3.md", "Plan: Q3");
    begin(&e, &store, &idea, "Idea.md", "Idea 2.md", "Idea 2");
    begin(&e, &store, &draft, "Draft.md", "Final.md", "Final");

    reopen(&mut e, true, |e| {
        rename(e, "Idea.md", "Idea 2.md");
        rename(e, "Plan.md", "Plan Q3.md");
    });

    // The title given, which no file name holds: the watcher would have titled the note by
    // its file name.
    assert_eq!(row(&e, &plan).as_deref(), Some("Plan Q3.md"));
    assert_eq!(title(&e, &plan), "Plan: Q3");
    assert_eq!(row(&e, &idea).as_deref(), Some("Idea 2.md"));
    assert_eq!(row(&e, &draft).as_deref(), Some("Draft.md"));
    assert_eq!(title(&e, &draft), "Draft");
    for id in [&plan, &idea, &draft] {
        assert_eq!(record(&e, id), None);
    }
}

/// A file note's row has no hash, so only the record pairs its moved file with it.
#[test]
fn a_recorded_move_of_a_file_note_is_finished_when_the_vault_opens() {
    let (mut e, store) = opened();
    let id = file_note(&e, &store, "scan.pdf", "scan");
    reopen(&mut e, true, |_| {});
    begin(&e, &store, &id, "scan.pdf", "Scan March.pdf", "Scan: March");

    reopen(&mut e, true, |e| rename(e, "scan.pdf", "Scan March.pdf"));

    assert_eq!(row(&e, &id).as_deref(), Some("Scan March.pdf"));
    assert_eq!(title(&e, &id), "Scan: March");
    assert_eq!(record(&e, &id), None);
}

/// On a volume that folds case both spellings name the file, so the open looks for the exact
/// name in its folder.
#[test]
fn a_recorded_move_that_changes_only_case_is_finished_when_the_vault_opens() {
    let (mut e, store) = opened();
    let id = markdown_note(&mut e, "plan.md");
    begin(&e, &store, &id, "plan.md", "Plan.md", "Plan");

    reopen(&mut e, true, |e| rename(e, "plan.md", "Plan.md"));

    assert_eq!(row(&e, &id).as_deref(), Some("Plan.md"));
    assert_eq!(record(&e, &id), None);
}

/// A note moved into a journal day's path is not that day: the record keeps its title and is
/// owed the move (Step 13m), and only the row follows the file.
#[test]
fn a_recorded_move_into_a_days_path_leaves_the_record_owed() {
    let (mut e, store) = opened();
    let id = markdown_note(&mut e, "work/2025-01-14.md");
    begin(
        &e,
        &store,
        &id,
        "work/2025-01-14.md",
        "journal/2025-01-14.md",
        "Jan 14",
    );

    reopen(&mut e, true, |e| {
        fs::create_dir_all(e.vault.join("journal")).unwrap();
        rename(e, "work/2025-01-14.md", "journal/2025-01-14.md");
    });

    assert_eq!(row(&e, &id).as_deref(), Some("journal/2025-01-14.md"));
    assert_eq!(title(&e, &id), "2025-01-14");
    let owed = writer(&e, &store).owed_places().unwrap();
    let owed: Vec<_> = owed.iter().map(|owed| owed.note_id.as_str()).collect();
    assert_eq!(owed, [id.as_str()]);
    assert_eq!(record(&e, &id), None);
}

/// Nothing of these moves is left to finish, so each record goes and the walk reports what is
/// on disk: another file at the new path (the move never replaces one), and neither file.
#[test]
fn a_recorded_move_whose_file_is_not_at_the_new_path_alone_is_forgotten() {
    let (mut e, store) = opened();
    let taken = markdown_note(&mut e, "Taken.md");
    let lost = markdown_note(&mut e, "Lost.md");
    begin(&e, &store, &taken, "Taken.md", "Other.md", "Other");
    begin(&e, &store, &lost, "Lost.md", "Found.md", "Found");

    reopen(&mut e, false, |e| {
        e.write("Other.md", "Someone else's\n");
        fs::remove_file(e.vault.join("Lost.md")).unwrap();
    });

    assert_eq!(row(&e, &taken).as_deref(), Some("Taken.md"));
    assert_eq!(title(&e, &taken), "Taken");
    assert_eq!(record(&e, &taken), None);
    assert_eq!(record(&e, &lost), None);
}

/// A move whose note's row is no longer at the old path has nothing left to finish, though the
/// file is at the new path alone: the row moved already (an older build's watcher paired the
/// file), or the note was deleted and its row went. The record goes, and the note's title stays.
#[test]
fn a_recorded_move_whose_row_moved_already_or_went_is_forgotten() {
    let (mut e, store) = opened();
    let there = markdown_note(&mut e, "There.md");
    let deleted = markdown_note(&mut e, "Deleted.md");
    begin(
        &e,
        &store,
        &there,
        "Before.md",
        "There.md",
        "There: at last",
    );
    begin(&e, &store, &deleted, "Deleted.md", "Gone.md", "Gone");
    writer(&e, &store).delete(deleted.clone()).unwrap();
    e.core().note_files().remove(&deleted).unwrap();

    reopen(&mut e, false, |e| rename(e, "Deleted.md", "Gone.md"));

    assert_eq!(row(&e, &there).as_deref(), Some("There.md"));
    assert_eq!(title(&e, &there), "There");
    assert_eq!(record(&e, &there), None);
    assert_eq!(title(&e, &deleted), "Deleted");
    assert_eq!(record(&e, &deleted), None);
}

/// A move the open cannot settle stays, logged, and does not stop the open or another note's
/// move: one whose finish fails (another row holds the new path), one whose folder cannot be
/// listed, and records another version wrote or no version can read, byte for byte.
#[test]
fn a_recorded_move_the_open_cannot_settle_is_logged_and_stays() {
    let (mut e, store) = opened();
    let held = markdown_note(&mut e, "Held.md");
    let later = markdown_note(&mut e, "Later.md");
    let newer = markdown_note(&mut e, "Newer.md");
    let garbled = markdown_note(&mut e, "Garbled.md");
    let plan = markdown_note(&mut e, "Plan.md");
    begin(&e, &store, &held, "Held.md", "Holder.md", "Holder");
    begin(&e, &store, &plan, "Plan.md", "Plan 2.md", "Plan 2");
    let unread = [
        (
            &newer,
            r#"{"version":2,"oldPath":"Newer.md","newPath":"N.md"}"#,
        ),
        (&garbled, "not json"),
    ];
    for (id, value) in unread {
        let (key, value) = (record_key(id), value.to_owned());
        e.core()
            .db_handle()
            .call_blocking(move |conn| {
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                    [key, value],
                )
                .unwrap();
                Ok(())
            })
            .unwrap();
    }
    let holder = writer(&e, &store).create("Holder".into(), None).unwrap();
    e.core()
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: holder,
            path: "Holder.md".into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: None,
            content_hash: None,
            file_hash: None,
            indexed_at: 0,
        })
        .unwrap();
    let log = Log::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(log.clone())
        .with_max_level(tracing::Level::WARN)
        .finish();

    tracing::subscriber::with_default(subscriber, || {
        reopen(&mut e, false, |e| {
            rename(e, "Held.md", "Holder.md");
            rename(e, "Plan.md", "Plan 2.md");
        });
    });

    assert!(record(&e, &held).is_some());
    for (id, value) in unread {
        assert_eq!(record(&e, id).as_deref(), Some(value));
    }
    let stays = "an interrupted app move stays for the next open";
    assert_eq!(log.text().matches(stays).count(), 3, "{}", log.text());
    assert_eq!(row(&e, &later).as_deref(), Some("Later.md"));
    assert_eq!(row(&e, &plan).as_deref(), Some("Plan 2.md"));
}

/// A folder of the move that cannot be listed leaves the open unable to tell where the file
/// is: the record stays.
#[cfg(unix)]
#[test]
fn a_recorded_move_whose_folder_cannot_be_listed_stays() {
    use std::os::unix::fs::PermissionsExt as _;

    let (mut e, store) = opened();
    let id = markdown_note(&mut e, "Plan.md");
    begin(&e, &store, &id, "Plan.md", "locked/Plan.md", "Plan");
    let locked = e.vault.join("locked");
    let mode = |mode| fs::set_permissions(&locked, fs::Permissions::from_mode(mode)).unwrap();

    reopen(&mut e, false, |e| {
        fs::create_dir(&locked).unwrap();
        rename(e, "Plan.md", "locked/Plan.md");
        mode(0o000);
    });
    mode(0o755);

    assert!(record(&e, &id).is_some());
}

/// What the open logged, for the test that it said why it left a record.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);

impl Log {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl Write for Log {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Log {
    type Writer = Log;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

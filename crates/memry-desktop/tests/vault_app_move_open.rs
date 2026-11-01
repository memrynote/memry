//! The vault open's finish of an app move a crash cut short (Step 13g, #3530), under the
//! running tier. Each test records a move in the core as the app does before it moves a file,
//! leaves the files as a crash would, and opens the vault: a move whose file got to its new
//! path is finished before the watcher starts, one whose file did not is forgotten, and a
//! record this version cannot read is logged and left for the version that wrote it.

mod device_key;
mod vault_env;

use std::fs;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::notes::app_move::{APP_MOVE_META_KEY, AppMoved, Recorded};
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
fn file_note(e: &Env, store: &Arc<dyn SecureStore>, rel: &str) -> String {
    fs::write(e.vault.join(rel), "%PDF-1.4\n").unwrap();
    let core = e.core();
    let id = core
        .notes_writer(store.clone())
        .unwrap()
        .create("scan".into(), None)
        .unwrap();
    core.note_files()
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
    let writer = e.core().notes_writer(store.clone()).unwrap();
    writer.begin_app_move(id, moved).unwrap();
}

/// Opens the vault again after `between` ran on the closed vault; the open's walk must report
/// no file as added, removed or moved.
fn reopen_quietly(e: &mut Env, between: impl FnOnce(&Env)) {
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
    assert_eq!(reported, None, "the watcher saw the interrupted move");
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

fn raw_record(e: &Env) -> Option<String> {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    [APP_MOVE_META_KEY],
                    |row| row.get(0),
                )
                .optional()
                .unwrap())
        })
        .unwrap()
}

fn pending(e: &Env, store: &Arc<dyn SecureStore>) -> Option<Recorded> {
    let writer = e.core().notes_writer(store.clone()).unwrap();
    writer.pending_app_move().unwrap()
}

#[test]
fn a_recorded_move_whose_file_moved_is_finished_when_the_vault_opens() {
    let (mut e, store) = opened();
    let id = markdown_note(&mut e, "Plan.md");
    begin(&e, &store, &id, "Plan.md", "Plan Q3.md", "Plan: Q3");

    reopen_quietly(&mut e, |e| rename(e, "Plan.md", "Plan Q3.md"));

    assert_eq!(e.rows(), [(id.clone(), "Plan Q3.md".to_owned())]);
    // The title given, which no file name holds: the watcher would have titled the note by
    // its file name.
    assert_eq!(title(&e, &id), "Plan: Q3");
    assert_eq!(pending(&e, &store), None);
}

/// A file note's row has no hash, so only the record pairs its moved file with it.
#[test]
fn a_recorded_move_of_a_file_note_is_finished_when_the_vault_opens() {
    let (mut e, store) = opened();
    let id = file_note(&e, &store, "scan.pdf");
    reopen_quietly(&mut e, |_| {});
    begin(&e, &store, &id, "scan.pdf", "Scan March.pdf", "Scan: March");

    reopen_quietly(&mut e, |e| rename(e, "scan.pdf", "Scan March.pdf"));

    assert_eq!(e.rows(), [(id.clone(), "Scan March.pdf".to_owned())]);
    assert_eq!(title(&e, &id), "Scan: March");
    assert_eq!(pending(&e, &store), None);
}

/// On a volume that folds case both spellings name the file, so the open looks for the exact
/// name in its folder.
#[test]
fn a_recorded_move_that_changes_only_case_is_finished_when_the_vault_opens() {
    let (mut e, store) = opened();
    let id = markdown_note(&mut e, "plan.md");
    begin(&e, &store, &id, "plan.md", "Plan.md", "Plan");

    reopen_quietly(&mut e, |e| rename(e, "plan.md", "Plan.md"));

    assert_eq!(e.rows(), [(id.clone(), "Plan.md".to_owned())]);
    assert_eq!(pending(&e, &store), None);
}

#[test]
fn a_recorded_move_whose_file_never_moved_is_forgotten_when_the_vault_opens() {
    let (mut e, store) = opened();
    let id = markdown_note(&mut e, "Plan.md");
    begin(&e, &store, &id, "Plan.md", "Later.md", "Later");

    reopen_quietly(&mut e, |_| {});

    assert_eq!(e.rows(), [(id.clone(), "Plan.md".to_owned())]);
    assert_eq!(title(&e, &id), "Plan");
    assert_eq!(pending(&e, &store), None);
}

/// A file at the new path while the note's is still at the old is another file (the move
/// refuses to replace one): the note stays with its own file.
#[test]
fn a_recorded_move_whose_new_path_holds_another_file_is_forgotten_when_the_vault_opens() {
    let (mut e, store) = opened();
    let id = markdown_note(&mut e, "Plan.md");
    begin(&e, &store, &id, "Plan.md", "Later.md", "Later");
    e.close();
    e.write("Later.md", "Someone else's\n");

    e.open();
    e.facts_until(indexed);

    let rows = e.rows();
    assert!(
        rows.contains(&(id.clone(), "Plan.md".to_owned())),
        "{rows:?}"
    );
    assert_eq!(title(&e, &id), "Plan");
    assert_eq!(pending(&e, &store), None);
}

/// Another version's record, or one that does not parse, does not stop the open, is logged,
/// and stays exactly as it was for the version that wrote it.
#[test]
fn a_record_this_version_cannot_read_is_logged_and_left_when_the_vault_opens() {
    let (mut e, _) = opened();
    let id = markdown_note(&mut e, "Plan.md");
    for value in [
        r#"{"version":2,"noteId":"x","oldPath":"Plan.md","newPath":"Later.md"}"#,
        "not json",
    ] {
        let record = value.to_owned();
        e.core()
            .db_handle()
            .call_blocking(move |conn| {
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [APP_MOVE_META_KEY, record.as_str()],
                )
                .unwrap();
                Ok(())
            })
            .unwrap();

        let log = Log::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(log.clone())
            .with_max_level(tracing::Level::WARN)
            .finish();
        tracing::subscriber::with_default(subscriber, || reopen_quietly(&mut e, |_| {}));

        assert_eq!(raw_record(&e).as_deref(), Some(value));
        assert!(
            log.text()
                .contains("an interrupted app move this version cannot read stays"),
            "{value}: {}",
            log.text()
        );
        assert_eq!(e.rows(), [(id.clone(), "Plan.md".to_owned())]);
    }
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

//! A note kept when its file was deleted outside the app (#4140), through a real vault session,
//! tier, identity, notes service and vault on disk: a restore writes the document's text back
//! to the note's path and the note reads, feeds and lists as before; a delete moves that text to
//! the trash before the tombstone; neither writes over a file, and neither goes on when the
//! document cannot give the whole text, unless the user confirmed the delete as permanent.

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::kept;
use memry_desktop::notes::read;
use memry_desktop::notes::service::{NotesService, Trash};
use memry_desktop::vault::app_edit::Kept;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::notices::{VaultNotice, VaultNotices};
use rusqlite::OptionalExtension as _;
use vault_env::{Env, env, indexed};

const FILE: &str = "---\ntags:\n  - alpha\n---\nAlpha\n";
const RESTORED: &str = "---\ntags:\n  - alpha\n---\ntyped in the app\n";

struct KeptNote {
    e: Env,
    _index: Arc<NoteIndex>,
    notes: Arc<NotesService>,
    notices: Arc<VaultNotices>,
    id: String,
}

/// The test's trash: the file moves beside itself as `<name>.trashed`, which no note reads.
fn bin(path: &Path) -> Result<(), String> {
    fs::rename(path, path.with_extension("trashed")).map_err(|error| error.to_string())
}

/// A trash that refuses every file, as a Linux mount with no usable `.Trash-<uid>` does.
fn no_trash(_: &Path) -> Result<(), String> {
    Err("no trash on this volume".into())
}

fn until(what: &str, holds: impl Fn() -> bool) {
    let deadline = Instant::now() + vault_env::WAIT;
    while !holds() {
        assert!(Instant::now() < deadline, "never: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn row_id(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .map(|(id, _)| id)
        .expect("a row")
}

/// The file at `rel` held `text`; the app's editor typed over it, and the file was deleted
/// outside the app before the write-back wrote it: the note is kept and listed.
fn kept_at(rel: &str, text: &str, trash: Trash) -> KeptNote {
    kept_by(rel, text, trash, |e, store, id| {
        // An edit stamped in the row's own millisecond is not after it.
        std::thread::sleep(Duration::from_millis(2));
        e.edit_in_app(store, id, "typed in the app");
    })
}

/// The row of `id` stops naming its file's text, as one a crash left between the file and the
/// row's hash does: the file's removal keeps the note.
fn unread(e: &Env, id: &str) {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute(
                "UPDATE note_files SET content_hash = NULL WHERE note_id = ?1",
                [id],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
}

/// [`kept_at`] with `ahead` making the note's row not say the file held the whole note.
fn kept_by(
    rel: &str,
    text: &str,
    trash: Trash,
    ahead: impl FnOnce(&Env, &Arc<dyn SecureStore>, &str),
) -> KeptNote {
    let notices = VaultNotices::new();
    let board = notices.clone();
    let mut kept = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::noticing(store, board))
    });
    notices.register(&e.session);
    // The app's index: it reads the file's header, which a restore writes back.
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    let store = kept.expect("the store");
    e.write(rel, text);
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, rel);
    let search = e.core().search().unwrap();
    until("the file's header is measured", || {
        search
            .note_stats(&id)
            .unwrap()
            .is_some_and(|stored| stored.stats.header_read)
    });
    ahead(&e, &store, &id);
    fs::remove_file(e.vault.join(rel)).unwrap();
    until("the kept removal is listed", || is_listed(&notices, &id));
    let notes = NotesService::with_trash(e.tier.clone(), store.clone(), trash);
    KeptNote {
        e,
        _index: index,
        notes,
        notices,

        id,
    }
}

fn is_listed(notices: &VaultNotices, id: &str) -> bool {
    notices.list().iter().any(|notice| {
        matches!(notice, VaultNotice::KeptRemovals { notes, .. }
            if notes.iter().any(|note| note.note_id == id))
    })
}

/// The row's `content_hash`, `None` when the row names no text; `Err` with no row.
fn row_hash(e: &Env, id: &str) -> Result<Option<String>, ()> {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT content_hash FROM note_files WHERE note_id = ?1",
                    [id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .unwrap())
        })
        .unwrap()
        .ok_or(())
}

/// Whether the record is tombstoned, and the outbox operations queued for it.
fn record(e: &Env, id: &str) -> (bool, Vec<String>) {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let deleted = conn
                .query_row(
                    "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1",
                    [&id],
                    |row| row.get(0),
                )
                .unwrap();
            let mut statement = conn
                .prepare("SELECT op FROM outbox WHERE item_id = ?1 ORDER BY id")
                .unwrap();
            let ops = statement
                .query_map([&id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap();
            Ok((deleted, ops))
        })
        .unwrap()
}

/// The note's server body is owed a pull: its document is not its text yet.
fn owe_body(e: &Env, id: &str) {
    let key = format!("sync.body_owed:{id}");
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute("INSERT INTO meta (key, value) VALUES (?1, '0:0')", [key])
                .unwrap();
            Ok(())
        })
        .unwrap();
}

#[test]
fn a_restore_writes_the_documents_text_back_and_the_note_is_whole_again() {
    let KeptNote {
        mut e,
        _index,
        notes,
        notices,
        id,
    } = kept_at("a.md", FILE, bin);
    let open = e.session.current().unwrap();
    let pushed = record(&e, &id);
    e.drain();

    kept::restore(&notes, &notices, &open, &id).unwrap();
    assert_eq!(e.read("a.md"), RESTORED);
    assert!(!is_listed(&notices, &id), "{:?}", notices.list());
    assert_eq!(row_hash(&e, &id), Ok(Some(content_hash(RESTORED))));
    assert_eq!(record(&e, &id), pushed, "a restore is a local file");
    let view = read::get(&open, &id, None)
        .unwrap()
        .expect("the note reads");
    assert_eq!(view.content.trim(), "typed in the app");
    let facts = e.drain();
    assert!(
        facts.iter().any(|fact| matches!(fact,
            Applied::Changed { note_id, source: ChangeSource::App, .. } if *note_id == id)),
        "{facts:?}"
    );

    // The row names the document's text: an outside edit of the file is fed as one.
    e.write("a.md", "---\ntags:\n  - alpha\n---\nEdited outside\n");
    e.facts_until(|fact| {
        matches!(fact, Applied::Changed { note_id, source: ChangeSource::Watcher, .. }
            if *note_id == id)
    });
    until("the document took the outside edit", || {
        e.body(&id) == "Edited outside"
    });
    assert_eq!(row_id(&e, "a.md"), id);
}

#[test]
fn a_restore_never_writes_over_a_file_that_is_back() {
    let KeptNote {
        mut e,
        _index,
        notes,
        notices,
        id,
    } = kept_at("a.md", FILE, bin);
    let open = e.session.current().unwrap();
    e.write("a.md", "Mine\n");
    until("the returned file takes the note off the list", || {
        !is_listed(&notices, &id)
    });
    e.drain();

    let refused = kept::restore(&notes, &notices, &open, &id);
    assert!(
        matches!(refused, Err(NotesError::NameConflict)),
        "{refused:?}"
    );
    assert_eq!(e.read("a.md"), "Mine\n");
}

#[test]
fn a_kept_note_whose_text_is_not_here_is_neither_restored_nor_deleted_unless_confirmed() {
    let KeptNote {
        e,
        _index,
        notes,
        notices,
        id,
    } = kept_at("a.md", FILE, bin);
    let open = e.session.current().unwrap();
    owe_body(&e, &id);
    let pushed = record(&e, &id);

    let refused = kept::restore(&notes, &notices, &open, &id);
    assert!(
        matches!(refused, Err(NotesError::EditKept(Kept::BodyNotPulled))),
        "{refused:?}"
    );
    assert!(!e.vault.join("a.md").exists(), "a file was written");
    let refused = kept::delete(&notes, &notices, &open, &id, false);
    assert!(
        matches!(refused, Err(NotesError::TrashUnavailable(_))),
        "{refused:?}"
    );
    assert!(!e.vault.join("a.md").exists(), "a file was left");
    assert!(!e.vault.join("a.trashed").exists(), "a file was trashed");
    assert_eq!(record(&e, &id), pushed, "the note went");
    assert_eq!(row_hash(&e, &id), Ok(None));
    assert!(is_listed(&notices, &id), "{:?}", notices.list());

    // The user confirmed it: deleted for good, as a file the trash refuses is.
    kept::delete(&notes, &notices, &open, &id, true).unwrap();
    let (deleted, ops) = record(&e, &id);
    assert!(deleted);
    assert_eq!(ops.last().map(String::as_str), Some("delete"));
    assert_eq!(row_hash(&e, &id), Err(()));
    assert!(!is_listed(&notices, &id), "{:?}", notices.list());
}

#[test]
fn a_kept_notes_delete_moves_its_text_to_the_trash_then_syncs_the_delete() {
    let KeptNote {
        e,
        _index,
        notes,
        notices,
        id,
    } = kept_at("a.md", FILE, bin);
    let open = e.session.current().unwrap();

    kept::delete(&notes, &notices, &open, &id, false).unwrap();
    assert_eq!(
        e.read("a.trashed"),
        RESTORED,
        "the text is not in the trash"
    );
    assert!(!e.vault.join("a.md").exists());
    let (deleted, ops) = record(&e, &id);
    assert!(deleted);
    assert_eq!(ops.last().map(String::as_str), Some("delete"));
    assert_eq!(row_hash(&e, &id), Err(()));
    assert!(!is_listed(&notices, &id), "{:?}", notices.list());
    assert_eq!(read::get(&open, &id, None).unwrap(), None);
}

#[test]
fn a_kept_note_the_trash_refuses_stays_kept_with_no_file_left() {
    let KeptNote {
        e,
        _index,
        notes,
        notices,
        id,
    } = kept_at("a.md", FILE, no_trash);
    let open = e.session.current().unwrap();
    let pushed = record(&e, &id);

    let refused = notes.delete(&open, &id, false);
    assert!(
        matches!(refused, Err(NotesError::TrashUnavailable(_))),
        "{refused:?}"
    );
    assert!(!e.vault.join("a.md").exists(), "the copy was left");
    assert_eq!(record(&e, &id), pushed, "the note went");
    assert_eq!(row_hash(&e, &id), Ok(None));
    // Still kept: a restore writes the text.
    kept::restore(&notes, &notices, &open, &id).unwrap();
    assert_eq!(e.read("a.md"), RESTORED);
}

#[test]
fn a_kept_journal_day_is_restored_with_its_date_and_deleted_to_the_trash() {
    let KeptNote {
        e,
        _index,
        notes,
        notices,
        id,
    } = kept_by("journal/2025-01-02.md", "Morning\n", bin, |e, _, id| {
        unread(e, id)
    });
    assert_eq!(id, "j2025-01-02");
    let open = e.session.current().unwrap();
    let day = "---\ndate: '2025-01-02'\n---\nMorning\n";

    kept::restore(&notes, &notices, &open, &id).unwrap();
    assert_eq!(e.read("journal/2025-01-02.md"), day);
    assert_eq!(row_hash(&e, &id), Ok(Some(content_hash(day))));

    // Kept again, then deleted: its text is in the trash.
    unread(&e, &id);
    fs::remove_file(e.vault.join("journal/2025-01-02.md")).unwrap();
    until("the day is listed again", || is_listed(&notices, &id));
    kept::delete(&notes, &notices, &open, &id, false).unwrap();
    assert_eq!(e.read("journal/2025-01-02.trashed"), day);
    assert!(!e.vault.join("journal/2025-01-02.md").exists());
    assert_eq!(row_hash(&e, &id), Err(()));
    assert!(!is_listed(&notices, &id), "{:?}", notices.list());
}

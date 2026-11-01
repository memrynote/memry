//! The app's own note writes (Step 13f, #3530) under the running vault tier: a create writes
//! the record, then the row, then the file, takes back what it made when a step fails, and
//! never writes over or takes back a file it did not write; a delete removes the file first,
//! for good when the note's document holds its text and to the trash when it does not, then
//! leaves the tombstone the 13d rules ask for; the watcher reports neither back as an outside
//! change, in its facts or in the activity log; an outside edit reads back as the fields
//! `notes:updated` carries.

mod device_key;
mod vault_env;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::activity::{ActivityFilter, ActivityKind};
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use rusqlite::OptionalExtension as _;
use serde_json::json;
use vault_env::{Env, env, indexed};

/// An open vault with its first walk done, and the notes service over its tier.
fn opened() -> (Env, Arc<NotesService>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    let notes = NotesService::with_trash(e.tier.clone(), kept.expect("the store"), bin);
    (e, notes)
}

/// The test's trash: the file moves beside itself as `<name>.trashed`, which no note reads.
fn bin(path: &Path) -> Result<(), String> {
    fs::rename(path, path.with_extension("trashed")).map_err(|error| error.to_string())
}

fn plan() -> NewNoteFile {
    NewNoteFile {
        title: "Plan".into(),
        content: "Hello world".into(),
        folder: Some("work".into()),
        tags: vec!["alpha".into()],
        properties: json!({ "status": "open" }).as_object().unwrap().clone(),
        emoji: Some("🙂".into()),
    }
}

const PLAN_FILE: &str = "---\ntags:\n  - alpha\nstatus: open\n---\nHello world\n";

/// `(id, deleted)` of every note record.
fn records(e: &Env) -> Vec<(String, bool)> {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare("SELECT id, deleted_at IS NOT NULL FROM notes ORDER BY id")
                .unwrap();
            Ok(statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap())
        })
        .unwrap()
}

/// The outbox operations queued for `id`, in order.
fn queued(e: &Env, id: &str) -> Vec<String> {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let mut statement = conn
                .prepare("SELECT op FROM outbox WHERE item_id = ?1 ORDER BY id")
                .unwrap();
            Ok(statement
                .query_map([id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap())
        })
        .unwrap()
}

fn slot(e: &Env, path: &str) -> Option<i64> {
    let path = path.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT position FROM note_positions WHERE path = ?1",
                    [path],
                    |row| row.get(0),
                )
                .optional()
                .unwrap())
        })
        .unwrap()
}

/// A folder the user ordered by hand: `work` holds one slot, 5.
fn order_work_folder(e: &Env) {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO note_positions (path, folder_path, position) \
                 VALUES ('work/Old.md', 'work', 5)",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
}

/// The row facts since the last drain, once the watcher had time to report what the app did,
/// without the app's own writes. The app's operation publishes its facts; a watcher fact among
/// them is the app's own write or removal taken for an outside one.
fn row_facts(e: &mut Env) -> Vec<Applied> {
    std::thread::sleep(vault_env::QUIET);
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

/// Writes a file as another program does and waits for the watcher's note of it: the activity
/// log then holds what the watcher reported up to here.
fn outside_file(e: &mut Env, rel: &str) {
    e.write(rel, "From elsewhere\n");
    e.facts_until(|fact| matches!(fact, Applied::Added { path, .. } if path == rel));
}

/// The `(kind, path)` of every activity entry, oldest first.
fn activity(e: &Env) -> Vec<(ActivityKind, String)> {
    let mut entries: Vec<_> = e
        .tier
        .activity()
        .list(1000, ActivityFilter::All)
        .entries
        .into_iter()
        .filter_map(|entry| Some((entry.kind, entry.path?)))
        .collect();
    entries.reverse();
    entries
}

fn added(id: &str, path: &str) -> Applied {
    Applied::Added {
        note_id: id.to_owned(),
        path: path.to_owned(),
        created: true,
        source: ChangeSource::App,
    }
}

fn removed(id: &str, path: &str) -> Applied {
    Applied::Removed {
        note_id: id.to_owned(),
        path: path.to_owned(),
        source: ChangeSource::App,
    }
}

#[test]
fn a_create_writes_the_record_then_the_row_then_the_file_and_seeds_the_body() {
    let (mut e, notes) = opened();
    let open = e.session.current().unwrap();
    order_work_folder(&e);
    let mut before_file = None;
    let mut at_file = None;
    let note = notes
        .create_checked(
            &open,
            plan(),
            &mut || {
                // The row is reserved and the file not written: a crash here leaves no file
                // that a later open would make a second note.
                before_file = Some((e.rows(), e.vault.join("work/Plan.md").exists()));
            },
            &mut || {
                // The file has landed and its body is not seeded yet.
                let row = e.rows();
                let file = fs::read_to_string(e.vault.join("work/Plan.md")).ok();
                at_file = Some((records(&e), row, file));
                Ok(())
            },
        )
        .unwrap();
    let (rows_before, file_before) = before_file.expect("the hook ran");
    assert_eq!(rows_before.len(), 1, "the row comes before the file");
    assert!(!file_before, "the file came before the row");
    let (records_then, rows_then, file_then) = at_file.expect("the hook ran");
    assert_eq!(
        records_then,
        [(note.id.clone(), false)],
        "the record came first"
    );
    assert_eq!(rows_then, [(note.id.clone(), "work/Plan.md".to_owned())]);
    assert_eq!(file_then.as_deref(), Some(PLAN_FILE));

    assert_eq!(note.path, "work/Plan.md");
    assert_eq!(note.header_tags, ["alpha"]);
    assert_eq!(
        note.properties,
        *json!({ "status": "open" }).as_object().unwrap()
    );
    assert_eq!(note.emoji.as_deref(), Some("🙂"));
    assert_eq!(e.read("work/Plan.md"), PLAN_FILE);
    assert_eq!(e.body(&note.id), "Hello world");
    let row = e.core().note_files().by_id(&note.id).unwrap().unwrap();
    let hash = Some(content_hash(PLAN_FILE));
    assert_eq!((row.content_hash, row.file_hash), (hash.clone(), hash));
    assert_eq!(
        slot(&e, "work/Plan.md"),
        Some(4),
        "first in its ordered folder"
    );

    let read = read::get(&open, &note.id, None).unwrap().expect("the note");
    // The body as the file holds it, final newline and all (`parseNote`).
    assert_eq!(read.content, "Hello world\n");
    assert_eq!(read.tags, ["alpha"]);
    assert_eq!(read.header_tags, ["alpha"]);
    assert_eq!(read.properties, note.properties);
    assert_eq!(read.word_count, 2);
    assert_eq!(row_facts(&mut e), [added(&note.id, "work/Plan.md")]);
    assert_eq!(e.rows().len(), 1, "a second note for one file");
    // The app's file is not one the watcher found; a file another program wrote is.
    outside_file(&mut e, "Outside.md");
    assert_eq!(
        activity(&e),
        [(ActivityKind::Added, "Outside.md".to_owned())]
    );
}

#[test]
fn a_failure_after_the_file_takes_back_the_file_the_row_and_the_record() {
    let (mut e, notes) = opened();
    let open = e.session.current().unwrap();
    let failed = notes.create_checked(&open, plan(), &mut || {}, &mut || {
        Err(NotesError::Io(std::io::Error::other("injected")))
    });
    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert!(
        !e.vault.join("work/Plan.md").exists(),
        "the new file stayed"
    );
    assert_eq!(e.rows(), []);
    let records = records(&e);
    assert_eq!(records.len(), 1);
    assert!(records[0].1, "the record is not a tombstone");
    // The note never was: no fact went out for it, so no note event; the removal is the
    // app's, so the watcher makes no note of it.
    assert_eq!(row_facts(&mut e), []);
    assert_eq!(e.rows(), []);
}

#[test]
fn a_note_made_from_a_note_carries_its_tags_properties_and_icon_beside_it() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    let source = notes.create(&open, plan()).unwrap();
    let source = read::get(&open, &source.id, None).unwrap().unwrap();
    // `useCreateNoteFromNote`: an empty note in the source's folder.
    let from = |title: &str| NewNoteFile {
        title: title.into(),
        content: String::new(),
        folder: source
            .path
            .rsplit_once('/')
            .map(|(folder, _)| folder.to_owned()),
        tags: source.header_tags.clone(),
        properties: source.properties.clone(),
        emoji: source.emoji.clone(),
    };
    let copy = notes.create(&open, from("Plan")).unwrap();
    assert_eq!(copy.path, "work/Plan 1.md", "the taken name was reused");
    assert_ne!(copy.id, source.id);
    let copy = read::get(&open, &copy.id, None).unwrap().unwrap();
    assert_eq!(copy.header_tags, source.header_tags);
    assert_eq!(copy.properties, source.properties);
    assert_eq!(copy.emoji, source.emoji);
    assert_eq!(copy.content, "");
    assert_eq!(
        e.read("work/Plan 1.md"),
        "---\ntags:\n  - alpha\nstatus: open\n---\n"
    );
    assert_eq!(e.read("work/Plan.md"), PLAN_FILE, "the source changed");
}

#[test]
fn a_delete_removes_the_file_for_good_and_queues_the_tombstone() {
    let (mut e, notes) = opened();
    let open = e.session.current().unwrap();
    order_work_folder(&e);
    let note = notes.create(&open, plan()).unwrap();
    assert_eq!(slot(&e, "work/Plan.md"), Some(4));
    assert_eq!(row_facts(&mut e), [added(&note.id, "work/Plan.md")]);

    notes.delete(&open, &note.id).unwrap();
    assert!(!e.vault.join("work/Plan.md").exists());
    assert!(
        !e.vault.join("work/Plan.trashed").exists(),
        "a file whose text the note held went to the trash"
    );
    assert_eq!(e.rows(), []);
    assert_eq!(records(&e), [(note.id.clone(), true)]);
    assert_eq!(
        queued(&e, &note.id).last().map(String::as_str),
        Some("delete")
    );
    assert_eq!(slot(&e, "work/Plan.md"), None);
    assert_eq!(read::get(&open, &note.id, None).unwrap(), None);
    assert_eq!(row_facts(&mut e), [removed(&note.id, "work/Plan.md")]);
    let again = notes.delete(&open, &note.id);
    assert!(matches!(again, Err(NotesError::NotFound(_))), "{again:?}");
    // The app's removal is not one the watcher found.
    outside_file(&mut e, "Outside.md");
    assert_eq!(
        activity(&e),
        [(ActivityKind::Added, "Outside.md".to_owned())]
    );
}

#[test]
fn a_local_only_note_is_deleted_here_and_pushes_no_tombstone() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    let note = notes.create(&open, plan()).unwrap();
    e.core()
        .note_files()
        .set_local_only(&note.id, true)
        .unwrap();

    notes.delete(&open, &note.id).unwrap();
    assert!(!e.vault.join("work/Plan.md").exists());
    assert_eq!(records(&e), [(note.id.clone(), true)]);
    assert_eq!(queued(&e, &note.id), Vec::<String>::new());
}

#[test]
fn what_the_open_walk_finds_is_the_walks_and_what_the_watcher_finds_is_the_watchers() {
    let (mut e, _notes) = opened();
    e.close();
    e.write("Closed.md", "Written while closed\n");
    e.open();
    let walked = e.facts_until(indexed);
    assert!(
        walked.iter().any(|fact| matches!(
            fact,
            Applied::Added { path, source: ChangeSource::Walk, .. } if path == "Closed.md"
        )),
        "{walked:?}"
    );
    e.write("Open.md", "Written while open\n");
    let watched =
        e.facts_until(|fact| matches!(fact, Applied::Added { path, .. } if path == "Open.md"));
    assert!(
        matches!(
            watched.last(),
            Some(Applied::Added {
                source: ChangeSource::Watcher,
                ..
            })
        ),
        "{watched:?}"
    );
}

/// The `properties` the record of `id` holds, as stored.
fn record_properties(e: &Env, id: &str) -> Option<String> {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row("SELECT properties FROM notes WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .unwrap())
        })
        .unwrap()
}

#[test]
fn a_file_that_appears_before_the_create_writes_stays_and_becomes_its_own_note() {
    let (mut e, notes) = opened();
    let open = e.session.current().unwrap();
    // The very bytes the create would write: the own-write record must not take them for its.
    let failed = notes.create_checked(
        &open,
        plan(),
        &mut || e.write("work/Plan.md", PLAN_FILE),
        &mut || Ok(()),
    );
    assert!(
        matches!(failed, Err(NotesError::NameConflict)),
        "{failed:?}"
    );
    assert_eq!(e.read("work/Plan.md"), PLAN_FILE, "the file was replaced");
    let records = records(&e);
    assert_eq!(records.len(), 1);
    let (taken_back, tombstone) = &records[0];
    assert!(tombstone, "the create's record is not a tombstone");
    // The watcher finds the file no row holds and makes it a note of its own.
    let facts = e.facts_until(|fact| {
        matches!(fact, Applied::Added { path, source: ChangeSource::Watcher, .. }
            if path == "work/Plan.md")
    });
    let Some(Applied::Added { note_id, .. }) = facts.last() else {
        panic!("{facts:?}");
    };
    assert_ne!(note_id, taken_back);
    assert_eq!(e.rows(), [(note_id.clone(), "work/Plan.md".to_owned())]);
    assert_eq!(e.read("work/Plan.md"), PLAN_FILE);
}

#[test]
fn a_name_a_file_no_row_names_yet_holds_is_skipped() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    // A file no row names yet: the watcher holds a new file back for its grace first.
    e.write("work/Plan.md", "From elsewhere\n");
    let note = notes.create(&open, plan()).unwrap();
    assert_eq!(note.path, "work/Plan 1.md");
    assert_eq!(e.read("work/Plan.md"), "From elsewhere\n");
}

#[test]
fn a_row_left_without_its_file_keeps_its_name_under_every_spelling() {
    let (mut e, notes) = opened();
    let lower = |title: &str| NewNoteFile {
        title: title.into(),
        folder: Some("lower".into()),
        ..NewNoteFile::default()
    };
    let open = e.session.current().unwrap();
    let kept = notes.create(&open, lower("plan")).unwrap();
    assert_eq!(kept.path, "lower/plan.md");
    // What a crash between a create's row and its file leaves: a row with no hash, no file.
    drop(open);
    e.close();
    fs::remove_file(e.vault.join("lower/plan.md")).unwrap();
    rusqlite::Connection::open(e.vault.join(".memry/core/data.db"))
        .unwrap()
        .execute_batch("UPDATE note_files SET content_hash = NULL; DELETE FROM note_file_hashes;")
        .unwrap();
    e.open();
    e.facts_until(indexed);
    row_facts(&mut e);
    // Nothing proves only the file went, so the note stays, listed with its file missing.
    assert_eq!(e.rows(), [(kept.id.clone(), "lower/plan.md".to_owned())]);
    let open = e.session.current().unwrap();
    // No file stands at `Plan.md`: the row's folded spelling alone takes the name, as on a
    // case-insensitive volume the two are one file.
    let note = notes.create(&open, lower("Plan")).unwrap();
    assert_eq!(note.path, "lower/Plan 1.md");
}

#[cfg(unix)]
#[test]
fn a_name_a_dangling_link_holds_is_skipped() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    fs::create_dir_all(e.vault.join("work")).unwrap();
    std::os::unix::fs::symlink("nowhere.md", e.vault.join("work/Plan.md")).unwrap();
    let note = notes.create(&open, plan()).unwrap();
    assert_eq!(note.path, "work/Plan 1.md");
    assert!(
        e.vault.join("work/Plan.md").symlink_metadata().is_ok(),
        "the link went"
    );
}

#[test]
fn a_create_checks_its_input_as_electron_does() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    let tags = |tags: Vec<String>| NewNoteFile { tags, ..plan() };
    let too_many = notes.create(&open, tags(vec!["t".into(); 51]));
    assert!(
        matches!(too_many, Err(NotesError::InvalidTags)),
        "{too_many:?}"
    );
    let too_long = notes.create(&open, tags(vec!["t".repeat(51)]));
    assert!(
        matches!(too_long, Err(NotesError::InvalidTags)),
        "{too_long:?}"
    );
    assert_eq!(records(&e), [], "a refused create made a record");

    // Whitespace alone is no body; reserved keys reach neither the file nor the record.
    let note = notes
        .create(
            &open,
            NewNoteFile {
                content: " \n\t\u{feff}\n".into(),
                properties: json!({ "status": "open", "tags": ["x"], "aliases": ["y"] })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..plan()
            },
        )
        .unwrap();
    assert_eq!(
        e.read("work/Plan.md"),
        "---\ntags:\n  - alpha\nstatus: open\n---\n"
    );
    assert_eq!(note.content, "");
    assert_eq!(
        record_properties(&e, &note.id).as_deref(),
        Some(r#"{"status":"open"}"#)
    );
}

#[test]
fn a_file_that_cannot_be_removed_fails_the_delete_and_leaves_the_note_whole() {
    let (e, notes) = opened();
    let open = e.session.current().unwrap();
    let note = notes.create(&open, plan()).unwrap();
    let file = e.vault.join("work/Plan.md");
    // An unlink refused: a read-only folder on Unix; on Windows, the file held open without
    // delete sharing (`remove_file` there ignores the read-only attribute).
    #[cfg(unix)]
    let held = {
        use std::os::unix::fs::PermissionsExt as _;
        let folder = e.vault.join("work");
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
        move || fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap()
    };
    #[cfg(windows)]
    let held = {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_SHARE_READ: u32 = 0x1;
        let handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&file)
            .unwrap();
        move || drop(handle)
    };
    // The precondition, on every platform: the file cannot be removed now. The share mode
    // still lets the delete read the file, so it takes the unlink path, not the trash.
    assert!(
        fs::remove_file(&file).is_err(),
        "the file could be removed, so the test proves nothing"
    );
    assert!(file.exists());
    let failed = notes.delete(&open, &note.id);
    held();
    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert_eq!(e.read("work/Plan.md"), PLAN_FILE);
    assert!(file.exists());
    assert_eq!(records(&e), [(note.id.clone(), false)], "the record went");
    assert_eq!(e.rows(), [(note.id.clone(), "work/Plan.md".to_owned())]);
    assert!(
        !queued(&e, &note.id).iter().any(|op| op == "delete"),
        "a tombstone was queued"
    );
    // Once the file can go, the delete goes through.
    notes.delete(&open, &note.id).unwrap();
    assert!(!file.exists());
}

#[test]
fn a_file_with_text_the_note_never_took_goes_to_the_trash() {
    let (mut e, notes) = opened();
    let open = e.session.current().unwrap();
    let note = notes.create(&open, plan()).unwrap();
    // The row names other text than the file's: an outside edit the watcher has not fed yet.
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            conn.execute("UPDATE note_files SET content_hash = 'older'", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(row_facts(&mut e), [added(&note.id, "work/Plan.md")]);

    notes.delete(&open, &note.id).unwrap();
    assert!(!e.vault.join("work/Plan.md").exists());
    assert_eq!(e.read("work/Plan.trashed"), PLAN_FILE, "not in the trash");
    assert_eq!(records(&e), [(note.id.clone(), true)]);
    assert_eq!(e.rows(), []);
    assert_eq!(row_facts(&mut e), [removed(&note.id, "work/Plan.md")]);
}

#[test]
fn an_outside_edit_reads_back_as_the_fields_notes_updated_carries() {
    let (mut e, notes) = opened();
    let open = e.session.current().unwrap();
    let note = notes.create(&open, plan()).unwrap();
    row_facts(&mut e);
    e.write(
        "work/Plan.md",
        "---\ntags:\n  - alpha\nstatus: done\n---\nHello there, world\n",
    );
    e.facts_until(|fact| {
        matches!(fact, Applied::Changed { note_id, source: ChangeSource::Watcher, .. }
            if *note_id == note.id)
    });
    let changes = read::get(&open, &note.id, None).unwrap().unwrap().changes();
    let mut keys: Vec<_> = changes.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "content",
            "modified",
            "properties",
            "snippet",
            "tags",
            "title",
            "wordCount"
        ]
    );
    assert_eq!(changes["title"], "Plan");
    assert_eq!(changes["content"], "Hello there, world\n");
    assert_eq!(changes["tags"], json!(["alpha"]));
    assert_eq!(changes["properties"], json!({ "status": "done" }));
    assert_eq!(changes["wordCount"], 3);
    assert_eq!(changes["snippet"], "Hello there, world");
    assert!(changes["modified"].is_i64());
}

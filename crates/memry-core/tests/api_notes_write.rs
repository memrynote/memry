//! The `NotesWriter` surface: create, rename, move, delete (T126's write half,
//! exported).
//!
//! Real SQLite, a real in-memory secure store, no transport. A write never
//! touches the network either — it queues an outbox row and returns.
//!
//! | Test                                              | Rule                                  |
//! | ------------------------------------------------- | ------------------------------------- |
//! | a created note is readable and queued             | data-model §C.4, durable before shown |
//! | two creates never collide                         | the core mints the id                 |
//! | the root is an explicit null, not an absent key   | chapter 13 §13.4                      |
//! | a rename moves only the title                     | field-level merge, chapter 06 §6.1    |
//! | a delete tombstones rather than vanishing         | chapter 07 §7.15                      |
//! | a device with no signing key cannot write         | no borrowed identity                  |
//! | a locked keychain is not a missing key            | `SecureStoreError::Locked` crosses    |

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{AuthError, SecureStoreError, StorageError};
use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// A secure store held in memory, answering exactly what it was given.
struct MemoryStore {
    entries: Mutex<HashMap<String, Vec<u8>>>,
    locked: bool,
}

impl MemoryStore {
    /// A device that has registered: a 64-byte Ed25519 secret, public half in
    /// the tail, which is where `local_device_id_hex` reads it from.
    fn registered() -> Arc<dyn SecureStore> {
        let mut secret = vec![7u8; 32];
        secret.extend_from_slice(&[9u8; 32]);
        let entries = HashMap::from([(format!("{:?}", SecureStoreKey::DeviceSigningKey), secret)]);
        Arc::new(Self {
            entries: Mutex::new(entries),
            locked: false,
        })
    }

    fn unregistered() -> Arc<dyn SecureStore> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            locked: false,
        })
    }

    fn locked() -> Arc<dyn SecureStore> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            locked: true,
        })
    }
}

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if self.locked {
            return Err(SecureStoreError::Locked);
        }
        Ok(self
            .entries
            .lock()
            .expect("the store lock")
            .get(&format!("{key:?}"))
            .cloned())
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.entries
            .lock()
            .expect("the store lock")
            .insert(format!("{key:?}"), value);
        Ok(())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.entries
            .lock()
            .expect("the store lock")
            .remove(&format!("{key:?}"));
        Ok(())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.entries.lock().expect("the store lock").clear();
        Ok(())
    }
}

fn vault(label: &str) -> (PathBuf, Vault) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-notes-write-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let opened = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (dir, opened)
}

/// A second handle on the same file, to read the rows the exported surface does
/// not return.
fn behind(dir: &Path) -> Db {
    open_data(&dir.join("data.db")).expect("second open")
}

fn scalar(db: &Db, sql: &str) -> Option<String> {
    db.call_blocking(|conn: &mut Connection| {
        conn.query_row(sql, [], |row| row.get::<_, Option<String>>(0))
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
    })
    .expect("the query")
}

fn count(db: &Db, sql: &str) -> i64 {
    db.call_blocking(|conn: &mut Connection| {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
    })
    .expect("the query")
}

#[test]
fn a_created_note_is_readable_and_queued() {
    let (dir, vault) = vault("create");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");

    let id = writer
        .create("Kitchen sink".to_string(), None)
        .expect("create");

    // Readable through the read surface, which is the shell's only view.
    let listed = vault.notes().list().expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, id);
    assert_eq!(listed[0].title, "Kitchen sink");

    // And queued for the server. A note that exists only locally is the
    // failure §C.4 is written against: shown to the user, never sent.
    assert_eq!(
        count(&behind(&dir), "SELECT COUNT(*) FROM outbox"),
        1,
        "the create must leave an outbox row behind"
    );
}

#[test]
fn two_creates_never_collide() {
    let (_dir, vault) = vault("ids");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");

    let first = writer.create(String::new(), None).expect("first");
    let second = writer.create(String::new(), None).expect("second");

    assert_ne!(first, second);
    // A note id is also its CRDT document id, so it has to survive §7.1's
    // shape or its body can never be pushed.
    for id in [&first, &second] {
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
            "`{id}` is not a document id"
        );
    }
}

#[test]
fn the_root_is_an_explicit_null() {
    // Absent means "the sender does not know this field" and every other
    // device keeps its own value (§13.4). A note moved to the root with an
    // absent key would stay in its folder everywhere else.
    let (dir, vault) = vault("root");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");
    let id = writer
        .create("Filed".to_string(), Some("Journal".to_string()))
        .expect("create");

    writer.move_to_folder(id.clone(), None).expect("move");

    let db = behind(&dir);
    assert_eq!(
        scalar(
            &db,
            &format!("SELECT folder_path FROM notes WHERE id = '{id}'")
        ),
        None
    );
    assert!(
        scalar(
            &db,
            &format!("SELECT payload FROM sync_items WHERE item_id = '{id}'")
        )
        .expect("a payload")
        .contains("folderPath"),
        "the payload must carry the key, set to null, not drop it"
    );
}

#[test]
fn a_rename_moves_only_the_title() {
    let (dir, vault) = vault("rename");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");
    let id = writer
        .create("Draft".to_string(), Some("Journal".to_string()))
        .expect("create");

    writer
        .rename(id.clone(), "Final".to_string())
        .expect("rename");

    let listed = vault.notes().list().expect("list");
    assert_eq!(listed[0].title, "Final");
    assert_eq!(
        scalar(
            &behind(&dir),
            &format!("SELECT folder_path FROM notes WHERE id = '{id}'")
        ),
        Some("Journal".to_string()),
        "a rename that also moved the note would be a field-level merge bug"
    );
}

#[test]
fn a_delete_tombstones_rather_than_vanishing() {
    let (dir, vault) = vault("delete");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");
    let id = writer.create("Gone".to_string(), None).expect("create");

    writer.delete(id.clone()).expect("delete");

    assert!(vault.notes().list().expect("list").is_empty());
    assert!(vault.notes().read(id.clone()).expect("read").is_none());
    // A row that simply disappeared has nothing left to send, and the note
    // returns on the next pull.
    assert_eq!(
        count(
            &behind(&dir),
            &format!("SELECT COUNT(*) FROM notes WHERE id = '{id}' AND deleted_at IS NOT NULL")
        ),
        1
    );
}

#[test]
fn a_device_with_no_signing_key_cannot_write() {
    let (_dir, vault) = vault("unregistered");

    let refused = vault.notes_writer(MemoryStore::unregistered());

    match refused {
        Err(AuthError::MalformedToken { what }) => {
            assert!(what.contains("identity"), "{what}");
        }
        Err(other) => panic!("expected a missing identity, got {other:?}"),
        Ok(_) => panic!("a device with no identity must not get a writer"),
    }
}

#[test]
fn a_locked_keychain_is_not_a_missing_key() {
    // The difference matters: read as "absent", a locked keychain would mint a
    // second identity for a device that already has one, splitting its clock.
    let (_dir, vault) = vault("locked");

    match vault.notes_writer(MemoryStore::locked()) {
        Err(AuthError::SecureStore { .. }) => {}
        Err(other) => panic!("expected the lock to cross unchanged, got {other:?}"),
        Ok(_) => panic!("a locked keychain must not yield a writer"),
    }
}

// MARK: - Folders (N806)

/// **The whole folder domain existed and nothing could reach it.**
///
/// That is what N806 records: the core could create, rename, move and delete
/// a folder, and no API method said so, so no shell could do any of it. This
/// asserts the exposure end to end through the surface a shell actually has.
#[test]
fn a_folder_can_be_created_renamed_moved_and_deleted() {
    let (dir, vault) = vault("folders");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");

    writer
        .create_folder("Projects".to_string(), None)
        .expect("create");
    assert!(
        vault
            .notes()
            .folders()
            .expect("folders")
            .iter()
            .any(|folder| folder.path == "Projects"),
        "the folder must be readable through the read surface"
    );

    writer
        .rename_folder("Projects".to_string(), "Work".to_string())
        .expect("rename");
    let folders = vault.notes().folders().expect("folders");
    assert!(folders.iter().any(|folder| folder.path == "Work"));
    assert!(!folders.iter().any(|folder| folder.path == "Projects"));

    writer
        .create_folder("Archive".to_string(), None)
        .expect("create the parent");
    writer
        .move_folder("Work".to_string(), Some("Archive".to_string()))
        .expect("move");
    assert!(
        vault
            .notes()
            .folders()
            .expect("folders")
            .iter()
            .any(|folder| folder.path == "Archive/Work")
    );

    let removed = writer
        .delete_folder("Archive/Work".to_string())
        .expect("delete");
    assert_eq!(removed, ["Archive/Work"]);

    // Every one of those left something for the server: a folder that exists
    // only locally is the same failure a local-only note is.
    assert!(
        count(&behind(&dir), "SELECT COUNT(*) FROM outbox") > 0,
        "the folder writes must leave outbox rows behind"
    );
}

/// **A folder still holding a live note refuses to delete**, rather than
/// cascading.
///
/// No chapter defines a cascading folder delete, and a note tombstone travels
/// to every device in the vault. Refusing costs a step in the shell's flow;
/// guessing costs the user their notes.
#[test]
fn deleting_a_folder_that_still_holds_a_note_is_refused() {
    let (_dir, vault) = vault("folder-occupied");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");

    writer
        .create_folder("Keep".to_string(), None)
        .expect("create");
    writer
        .create("Inside".to_string(), Some("Keep".to_string()))
        .expect("the note");

    assert!(
        writer.delete_folder("Keep".to_string()).is_err(),
        "a folder holding a live note must not be deleted"
    );
    assert!(
        vault
            .notes()
            .folders()
            .expect("folders")
            .iter()
            .any(|folder| folder.path == "Keep"),
        "and the folder must still be there"
    );
}

/// A rename reports the notes it rewrote, so a shell can refresh exactly
/// those rather than reloading the vault.
#[test]
fn renaming_a_folder_reports_the_notes_it_moved() {
    let (_dir, vault) = vault("folder-rename-notes");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");

    writer
        .create_folder("Before".to_string(), None)
        .expect("create");
    let id = writer
        .create("Filed".to_string(), Some("Before".to_string()))
        .expect("the note");

    let moved = writer
        .rename_folder("Before".to_string(), "After".to_string())
        .expect("rename");

    assert_eq!(moved, std::slice::from_ref(&id));
    let listed = vault.notes().list().expect("list");
    let note = listed.iter().find(|note| note.id == id).expect("the note");
    assert_eq!(note.folder_path.as_deref(), Some("After"));
}

// MARK: - Templates and reminders (N803, N804)

/// A note made from a template carries the template's seed.
///
/// **Different from a create plus a paste**: the template's properties arrive
/// as properties rather than as text, which is the whole point of a template.
#[test]
fn a_note_made_from_a_template_carries_its_seed() {
    use memry_core::domain::templates::{self, NewTemplate};

    let (_dir, vault) = vault("template");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");

    let device = writer.device_id();
    let db = behind(&_dir);
    db.call_blocking(move |conn: &mut rusqlite::Connection| {
        templates::create(
            conn,
            &NewTemplate {
                id: "tpl-1",
                name: "Meeting",
                description: Some("Agenda and actions"),
                icon: Some("📋"),
                content: "## Agenda\n\n## Actions",
            },
            &device,
            1_760_000_000_000,
        )?;
        Ok(())
    })
    .expect("the template");

    // Readable through the surface a shell has.
    let listed = vault.notes().templates().expect("templates");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Meeting");
    assert_eq!(listed[0].icon.as_deref(), Some("📋"));

    let id = writer
        .create_from_template("tpl-1".to_string(), "Monday".to_string(), None)
        .expect("create from template");

    let note = vault
        .notes()
        .list()
        .expect("list")
        .into_iter()
        .find(|note| note.id == id)
        .expect("the note");
    assert_eq!(note.title, "Monday");
}

/// A reminder is readable against the note it points at.
#[test]
fn a_reminder_is_set_and_read_back_against_its_note() {
    let (_dir, vault) = vault("reminder");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");
    let note = writer
        .create("Remind me".to_string(), None)
        .expect("the note");

    let id = writer
        .add_reminder(
            note.clone(),
            "2026-09-23T09:00:00.000Z".to_string(),
            Some("Stand-up".to_string()),
        )
        .expect("the reminder");

    let found = vault.notes().reminders(note.clone()).expect("reminders");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, id);
    assert_eq!(found[0].target_type, "note");
    assert_eq!(found[0].target_id, note);
    assert_eq!(found[0].remind_at, "2026-09-23T09:00:00.000Z");
    assert_eq!(found[0].status, "pending");
}

/// **Dismissing is a status change, never a delete.**
///
/// A dismissal has to reach the other devices, and a row that vanished has
/// nothing left to send — the same rule a note tombstone follows.
#[test]
fn dismissing_a_reminder_keeps_the_row_and_changes_its_status() {
    let (_dir, vault) = vault("reminder-dismiss");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");
    let note = writer.create("N".to_string(), None).expect("the note");
    let id = writer
        .add_reminder(note.clone(), "2026-09-23T09:00:00.000Z".to_string(), None)
        .expect("the reminder");

    writer.dismiss_reminder(id.clone()).expect("dismiss");

    let found = vault.notes().reminders(note).expect("reminders");
    assert_eq!(found.len(), 1, "the row must survive a dismissal");
    assert_eq!(found[0].status, "dismissed");
}

/// Snoozing records when to come back, which is state that does sync.
#[test]
fn snoozing_a_reminder_records_when_to_come_back() {
    let (_dir, vault) = vault("reminder-snooze");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");
    let note = writer.create("N".to_string(), None).expect("the note");
    let id = writer
        .add_reminder(note.clone(), "2026-09-23T09:00:00.000Z".to_string(), None)
        .expect("the reminder");

    writer
        .snooze_reminder(id, "2026-09-24T09:00:00.000Z".to_string())
        .expect("snooze");

    let found = vault.notes().reminders(note).expect("reminders");
    assert_eq!(found[0].status, "snoozed");
    assert_eq!(
        found[0].snoozed_until.as_deref(),
        Some("2026-09-24T09:00:00.000Z")
    );
}

/// A note nothing points at has no reminders, which is an answer.
#[test]
fn a_note_with_no_reminders_reads_empty() {
    let (_dir, vault) = vault("reminder-none");
    let writer = vault
        .notes_writer(MemoryStore::registered())
        .expect("writer");
    let note = writer.create("N".to_string(), None).expect("the note");

    assert!(vault.notes().reminders(note).expect("reminders").is_empty());
}

// MARK: - Linked tasks (N807)

/// Writes a task row straight into the projection.
///
/// The projection is what the read queries, and `NewTask` carries no
/// `source_note_id`, so seeding the row directly is the honest way to test
/// the query rather than inventing a create path that does not exist.
fn seed_task(
    db: &Db,
    id: &str,
    title: &str,
    source_note_id: Option<&str>,
    linked: &str,
    completed_at: Option<&str>,
    archived_at: Option<&str>,
) {
    let id = id.to_owned();
    let title = title.to_owned();
    let source = source_note_id.map(str::to_owned);
    let linked = linked.to_owned();
    let completed = completed_at.map(str::to_owned);
    let archived = archived_at.map(str::to_owned);
    db.call_blocking(move |conn: &mut rusqlite::Connection| {
        conn.execute(
            "INSERT INTO tasks (
                 id, title, project_id, priority, position,
                 source_note_id, linked_note_ids, completed_at, archived_at
             ) VALUES (?1, ?2, 'project-1', 0, 0, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, title, source, linked, completed, archived],
        )
        .expect("the task row");
        Ok(())
    })
    .expect("the seed");
}

/// **Two different relationships, told apart.**
///
/// A task carries `source_note_id` for the note it was written in and
/// `linked_note_ids` for every note it references. Collapsing the two would
/// make "this note made this task" and "this task mentions this note" look
/// the same.
#[test]
fn a_notes_linked_tasks_say_which_ones_came_from_it() {
    let (dir, vault) = vault("linked-tasks");
    let db = behind(&dir);

    seed_task(&db, "t1", "Written here", Some("note-1"), "[]", None, None);
    seed_task(&db, "t2", "Mentions it", None, "[\"note-1\"]", None, None);
    seed_task(&db, "t3", "Unrelated", None, "[\"note-2\"]", None, None);

    let found = vault
        .notes()
        .linked_tasks("note-1".to_string())
        .expect("linked tasks");

    let ids: Vec<&str> = found.iter().map(|task| task.id.as_str()).collect();
    assert_eq!(ids.len(), 2, "{found:?}");
    assert!(ids.contains(&"t1") && ids.contains(&"t2"));

    let origin = found.iter().find(|task| task.id == "t1").expect("t1");
    assert!(origin.from_this_note, "t1 was written in this note");
    let mention = found.iter().find(|task| task.id == "t2").expect("t2");
    assert!(!mention.from_this_note, "t2 only references it");
}

/// **A completed task stays, an archived one goes.**
///
/// An archive is not a to-do list, but a section that hid completed work
/// would look like the work was never there.
#[test]
fn completed_tasks_stay_and_archived_ones_do_not() {
    let (dir, vault) = vault("linked-tasks-state");
    let db = behind(&dir);

    seed_task(
        &db,
        "done",
        "Done",
        Some("note-1"),
        "[]",
        Some("2026-09-22"),
        None,
    );
    seed_task(
        &db,
        "filed",
        "Archived",
        Some("note-1"),
        "[]",
        None,
        Some("2026-09-22"),
    );

    let found = vault
        .notes()
        .linked_tasks("note-1".to_string())
        .expect("linked tasks");

    let ids: Vec<&str> = found.iter().map(|task| task.id.as_str()).collect();
    assert_eq!(ids, ["done"], "{found:?}");
    assert!(found[0].is_done);
}

/// A note nothing points at has no tasks, which is an answer rather than an
/// error.
#[test]
fn a_note_with_no_linked_tasks_reads_empty() {
    let (_dir, vault) = vault("linked-tasks-none");
    assert!(
        vault
            .notes()
            .linked_tasks("note-1".to_string())
            .expect("linked tasks")
            .is_empty()
    );
}

/// **A task block's card carries its project, priority and date.** A
/// `taskBlock` holds only the id and title (§12.7); desktop draws the rest
/// from the task, and a phone that could not would show a bare checkbox.
#[test]
fn a_task_card_reads_its_project_and_state() {
    let (dir, vault) = vault("task-card");
    let db = behind(&dir);
    seed_task(&db, "t1", "Renew licence", None, "[]", None, None);
    db.call_blocking(|conn: &mut rusqlite::Connection| {
        conn.execute(
            "INSERT INTO projects (id, name, color, position) VALUES ('project-1', 'Inbox', '#6b7280', 0)",
            [],
        )
        .expect("the project row");
        conn.execute("UPDATE tasks SET priority = 3, due_date = '2026-10-03' WHERE id = 't1'", [])
            .expect("the task fields");
        Ok(())
    })
    .expect("the seed");

    let card = vault
        .notes()
        .task("t1".to_string())
        .expect("the read")
        .expect("a card");
    assert_eq!(card.title, "Renew licence");
    assert!(!card.is_done);
    assert_eq!(card.priority, 3);
    assert_eq!(card.due_date.as_deref(), Some("2026-10-03"));
    assert_eq!(card.project_name.as_deref(), Some("Inbox"));

    assert_eq!(
        vault.notes().task("gone".to_string()).expect("the read"),
        None
    );
}

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
use std::path::PathBuf;
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
fn behind(dir: &PathBuf) -> Db {
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

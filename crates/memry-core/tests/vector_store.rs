//! `vectors.db` on real SQLite files: the open policy and `VectorStore`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::errors::StorageError;
use memry_core::storage::migrations::user_version;
use memry_core::storage::vector_db::{self, NoteState, VECTOR_BYTES, VectorBytes, VectorStore};
use memry_core::storage::{Db, open_data, open_index};
use rusqlite::Connection;

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "memry-vector-store-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Self(dir)
    }

    fn vectors(&self) -> PathBuf {
        self.0.join("vectors.db")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn opened(path: &Path) -> Db {
    vector_db::open(path, true)
        .expect("open")
        .expect("opted in")
}

fn with<T>(db: &Db, f: impl FnOnce(&Connection) -> Result<T, StorageError>) -> T {
    db.call_blocking(|conn| f(conn)).expect("vectors.db call")
}

fn sql(conn: &Connection, statements: &str) -> Result<(), StorageError> {
    conn.execute_batch(statements)
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
}

fn vector(fill: u8) -> VectorBytes {
    [fill; VECTOR_BYTES]
}

fn state(note_id: &str, vector_key: &str, window_count: u32) -> NoteState {
    NoteState {
        note_id: note_id.to_owned(),
        vector_key: vector_key.to_owned(),
        input_version: 6,
        source_key: [7; 32],
        window_count,
    }
}

fn scan(db: &Db, vector_key: &str) -> Vec<(String, u32, VectorBytes)> {
    with(db, |conn| VectorStore::new(conn).scan(vector_key))
}

#[test]
fn opted_out_deletes_the_file_and_its_sidecars() {
    let scratch = Scratch::new("opt-out");
    let path = scratch.vectors();
    drop(opened(&path));
    std::fs::write(sidecar(&path, "-wal"), b"log").expect("wal");
    std::fs::write(sidecar(&path, "-shm"), b"shm").expect("shm");

    assert!(vector_db::open(&path, false).expect("open").is_none());

    for leftover in [path.clone(), sidecar(&path, "-wal"), sidecar(&path, "-shm")] {
        assert!(
            !leftover.exists(),
            "{} survived opt-out",
            leftover.display()
        );
    }
}

#[test]
fn opted_out_with_no_file_is_not_an_error() {
    let scratch = Scratch::new("opt-out-absent");
    assert!(
        vector_db::open(&scratch.vectors(), false)
            .expect("open")
            .is_none()
    );
}

#[test]
fn rows_survive_a_reopen() {
    let scratch = Scratch::new("reopen");
    let path = scratch.vectors();
    let db = opened(&path);
    with(&db, |conn| {
        VectorStore::new(conn).replace_note(&state("n1", "gemma-a", 2), &[vector(1), vector(2)], 1)
    });
    drop(db);

    let db = opened(&path);
    assert_eq!(
        scan(&db, "gemma-a"),
        [
            ("n1".to_owned(), 0, vector(1)),
            ("n1".to_owned(), 1, vector(2))
        ]
    );
    assert_eq!(with(&db, user_version), 1);
}

#[test]
fn a_corrupt_file_is_rebuilt_empty() {
    let scratch = Scratch::new("corrupt");
    let path = scratch.vectors();
    std::fs::write(&path, b"this is not a SQLite database").expect("garbage");

    let db = opened(&path);

    assert_eq!(with(&db, user_version), 1);
    assert!(with(&db, |conn| VectorStore::new(conn).states()).is_empty());
}

#[test]
fn a_newer_additive_file_opens_untouched_and_stays_readable() {
    let scratch = Scratch::new("newer");
    let path = scratch.vectors();
    let db = opened(&path);
    with(&db, |conn| {
        sql(
            conn,
            "ALTER TABLE note_vectors ADD COLUMN quantized BLOB;
             ALTER TABLE note_vector_state ADD COLUMN model_rev TEXT NOT NULL DEFAULT '';
             PRAGMA user_version = 2;",
        )?;
        VectorStore::new(conn).replace_note(&state("n1", "gemma-a", 1), &[vector(3)], 1)
    });
    drop(db);

    let db = opened(&path);

    assert_eq!(with(&db, user_version), 2);
    assert_eq!(scan(&db, "gemma-a"), [("n1".to_owned(), 0, vector(3))]);
    with(&db, |conn| {
        VectorStore::new(conn).replace_note(&state("n2", "gemma-a", 1), &[vector(4)], 2)
    });
    assert_eq!(
        with(&db, |conn| VectorStore::new(conn).counts("gemma-a")),
        2
    );
}

#[test]
fn a_failed_replace_keeps_the_previous_vectors() {
    let scratch = Scratch::new("atomic");
    let db = opened(&scratch.vectors());
    with(&db, |conn| {
        VectorStore::new(conn).replace_note(&state("n1", "gemma-a", 2), &[vector(1), vector(2)], 1)
    });
    with(&db, |conn| {
        sql(
            conn,
            "CREATE TEMP TRIGGER fail_second_window BEFORE INSERT ON main.note_vectors
             WHEN NEW.window = 1 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
    });

    let mut rebuilt = state("n1", "gemma-b", 3);
    rebuilt.source_key = [9; 32];
    let result = db.call_blocking(|conn| {
        VectorStore::new(conn).replace_note(&rebuilt, &[vector(5), vector(6), vector(7)], 2)
    });

    assert!(result.is_err());
    assert_eq!(
        scan(&db, "gemma-a"),
        [
            ("n1".to_owned(), 0, vector(1)),
            ("n1".to_owned(), 1, vector(2))
        ]
    );
    assert_eq!(
        with(&db, |conn| VectorStore::new(conn).states()),
        [state("n1", "gemma-a", 2)]
    );
}

#[test]
fn replace_swaps_every_window_and_the_state() {
    let scratch = Scratch::new("replace");
    let db = opened(&scratch.vectors());
    with(&db, |conn| {
        let store = VectorStore::new(conn);
        store.replace_note(
            &state("n1", "gemma-a", 3),
            &[vector(1), vector(2), vector(3)],
            1,
        )?;
        store.replace_note(&state("n1", "gemma-a", 1), &[vector(9)], 2)
    });

    assert_eq!(scan(&db, "gemma-a"), [("n1".to_owned(), 0, vector(9))]);
    assert_eq!(
        with(&db, |conn| VectorStore::new(conn).states()),
        [state("n1", "gemma-a", 1)]
    );
}

#[test]
fn a_window_count_that_disagrees_with_the_vectors_is_refused() {
    let scratch = Scratch::new("count");
    let db = opened(&scratch.vectors());

    let result = db.call_blocking(|conn| {
        VectorStore::new(conn).replace_note(&state("n1", "gemma-a", 2), &[vector(1)], 1)
    });

    assert!(result.is_err());
    assert!(with(&db, |conn| VectorStore::new(conn).states()).is_empty());
}

#[test]
fn a_short_note_has_a_state_row_and_no_windows() {
    let scratch = Scratch::new("short");
    let db = opened(&scratch.vectors());
    with(&db, |conn| {
        VectorStore::new(conn).replace_note(&state("tiny", "gemma-a", 0), &[], 1)
    });

    assert!(scan(&db, "gemma-a").is_empty());
    assert_eq!(
        with(&db, |conn| VectorStore::new(conn).counts("gemma-a")),
        1
    );
}

#[test]
fn prune_is_idempotent() {
    let scratch = Scratch::new("prune");
    let db = opened(&scratch.vectors());
    with(&db, |conn| {
        let store = VectorStore::new(conn);
        store.replace_note(&state("n1", "gemma-a", 1), &[vector(1)], 1)?;
        store.replace_note(&state("n2", "gemma-a", 1), &[vector(2)], 1)
    });
    let gone = ["n1".to_owned(), "never-embedded".to_owned()];

    with(&db, |conn| VectorStore::new(conn).prune(&gone));
    with(&db, |conn| VectorStore::new(conn).prune(&gone));

    assert_eq!(scan(&db, "gemma-a"), [("n2".to_owned(), 0, vector(2))]);
    assert_eq!(
        with(&db, |conn| VectorStore::new(conn).states()),
        [state("n2", "gemma-a", 1)]
    );
}

#[test]
fn scan_and_counts_skip_another_vector_key() {
    let scratch = Scratch::new("key");
    let db = opened(&scratch.vectors());
    with(&db, |conn| {
        let store = VectorStore::new(conn);
        store.replace_note(&state("old", "gemma-a", 1), &[vector(1)], 1)?;
        let mut stale = state("stale", "gemma-b", 1);
        stale.input_version = 5;
        store.replace_note(&stale, &[vector(2)], 1)?;
        store.replace_note(&state("new", "gemma-b", 1), &[vector(3)], 1)
    });

    assert_eq!(
        scan(&db, "gemma-b"),
        [
            ("new".to_owned(), 0, vector(3)),
            ("stale".to_owned(), 0, vector(2))
        ]
    );
    assert_eq!(
        with(&db, |conn| VectorStore::new(conn).counts("gemma-b")),
        2
    );
    assert_eq!(
        with(&db, |conn| VectorStore::new(conn).counts("gemma-c")),
        0
    );
}

#[test]
fn a_vault_with_vectors_keeps_index_db_at_version_3() {
    let scratch = Scratch::new("vault");
    let data = open_data(&scratch.0.join("data.db")).expect("data.db");
    let index = open_index(&scratch.0.join("index.db")).expect("index.db");
    drop(opened(&scratch.vectors()));
    drop(index);

    let reopened = open_index(&scratch.0.join("index.db")).expect("reopen index.db");

    assert!(reopened.rebuild_reason.is_none());
    assert_eq!(with(&reopened.db, user_version), 3);
    assert!(with(&data, user_version) >= 17);
}

fn one_note(path: &Path) {
    let db = opened(path);
    with(&db, |conn| {
        VectorStore::new(conn).replace_note(&state("n1", "gemma-a", 1), &[vector(1)], 1)
    });
}

#[cfg(unix)]
#[test]
fn probe_unreadable_file_is_not_deleted() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("unreadable");
    let path = scratch.vectors();
    one_note(&path);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("chmod 000");

    let result = vector_db::open(&path, true);

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod 644");
    assert!(result.is_err(), "an unreadable file opened");
    assert_eq!(
        scan(&opened(&path), "gemma-a"),
        [("n1".to_owned(), 0, vector(1))]
    );
}

#[cfg(unix)]
#[test]
fn probe_locked_file_is_not_deleted() {
    use std::os::unix::fs::MetadataExt;
    let scratch = Scratch::new("locked");
    let path = scratch.vectors();
    one_note(&path);
    let inode = std::fs::metadata(&path).expect("metadata").ino();
    let holder = Connection::open(&path).expect("holder");
    holder
        .execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;")
        .expect("exclusive lock");

    let result = vector_db::open(&path, true);

    drop(holder);
    assert!(result.is_err(), "a locked file opened");
    assert_eq!(std::fs::metadata(&path).expect("metadata").ino(), inode);
    assert_eq!(
        scan(&opened(&path), "gemma-a"),
        [("n1".to_owned(), 0, vector(1))]
    );
}

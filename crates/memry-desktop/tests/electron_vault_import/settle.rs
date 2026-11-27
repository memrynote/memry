//! Stage 36c4 end to end: an Electron vault whose Yjs store is ahead of a note's file, imported,
//! installed, then opened in a real session until the consumer and the write-back settle.
//! Electron's store wins over the file (`crdt-provider.ts:1853-1855`) and its next write-back
//! writes the body over a file whose hash is the cached one, keeping the file as a version
//! (`crdt-writeback.ts:827-878`); the first session after the import does the same.

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use memry_desktop::electron_import::ProfileLock;
use memry_desktop::electron_import::vault_db::{VaultImportInput, stage_vault_import};
use memry_desktop::vault::hash::content_hash;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::docs::folded;
use super::queue::text;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::writeback::DEBOUNCE;

use super::vault_env::{Env, QUIET, WAIT, creates, env, indexed};
use super::{ELECTRON_DEVICE, electron_db, electron_hashes, electron_profile, staged};

const NOTE: &str = "Settle-note1";
const PATH: &str = "n.md";

struct Fixture {
    /// The text of the file Electron last read (`note_cache.content_hash`).
    read: &'static str,
    /// The file on disk at the import.
    file: &'static str,
    /// The body in Electron's Yjs store.
    body: &'static str,
    owed_file_body: bool,
    queued_push: bool,
    /// `note_cache.pending_write_hash` (Electron index 0037, #5698).
    pending: Pending,
}

#[derive(Clone, Copy)]
enum Pending {
    None,
    /// A bare `unstored-file` mark, as a crash before the store held a write-back leaves it in
    /// an earlier build of #5698: the file may hold typing the store lacks.
    UnstoredMark,
    /// The hash of the file on disk: Electron's own write-back, not recorded before it quit.
    File,
}

const AHEAD: Fixture = Fixture {
    read: "A\n",
    file: "A\n",
    body: "B\n",
    owed_file_body: false,
    queued_push: false,
    pending: Pending::None,
};

struct Settled {
    e: Env,
    electron: [PathBuf; 2],
    before: (
        std::collections::BTreeMap<&'static str, String>,
        std::collections::BTreeMap<&'static str, String>,
    ),
}

impl Settled {
    fn electron_unchanged(&self) {
        assert_eq!(
            (
                electron_hashes(&self.electron[0]),
                electron_hashes(&self.electron[1])
            ),
            self.before,
            "the Electron databases are byte for byte as before the import"
        );
    }

    fn until_file(&self, text: &str) {
        let deadline = Instant::now() + WAIT;
        while self.e.read(PATH) != text {
            assert!(Instant::now() < deadline, "{PATH}: {:?}", self.e.read(PATH));
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn until_body(&self, text: &str) {
        let deadline = Instant::now() + WAIT;
        while self.e.body(NOTE) != text {
            assert!(Instant::now() < deadline, "body {:?}", self.e.body(NOTE));
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn has_version(&self, text: char) {
        let versions = self.e.versions(NOTE);
        assert!(versions.iter().any(|v| v.contains(text)), "{versions:?}");
    }

    /// The file once the write-back's debounce and a quiet spell have passed with no write of
    /// the app's to the note. The over-Electron vault mints no note for a new file, so the
    /// reconcile barrier of `vault_env` (a probe file seen added) is not available here; the
    /// positive cases above show the same open writes within this window.
    fn quiet_file(&mut self) -> String {
        std::thread::sleep(DEBOUNCE + QUIET);
        let wrote = self.e.drain().into_iter().any(|fact| {
            matches!(fact, Applied::Changed { note_id, source: ChangeSource::App, .. } if note_id == NOTE)
        });
        assert!(!wrote, "the app wrote {PATH}");
        self.e.read(PATH)
    }
}

/// Imports the fixture's Electron vault, installs it and opens it in a session that runs until
/// the open walk is done; its reconcile (the write-back's first pass) runs right after.
fn import_and_open(fixture: &Fixture) -> Settled {
    let mut e = env(|store| Some(creates(store)));
    let pair = electron_db::create_pair(&e.vault.join(".memry"));
    let data = Connection::open(&pair.data).unwrap();
    electron_db::seed(
        &data,
        "note_metadata",
        &[
            ("id", text(NOTE)),
            ("path", text(PATH)),
            ("title", text("n")),
            ("file_type", text("markdown")),
            ("local_only", Value::Integer(0)),
            ("clock", text(r#"{"dev-A":2}"#)),
            ("synced_at", text("2026-01-04T00:00:00.000Z")),
            ("created_at", text("2026-01-02T03:04:05.000Z")),
            ("modified_at", text("2026-01-03T03:04:05.000Z")),
        ],
    );
    if fixture.owed_file_body {
        electron_db::seed(
            &data,
            "crdt_owed_file_bodies",
            &[("note_id", text(NOTE)), ("created_at", Value::Integer(5))],
        );
    }
    let doc = folded(NOTE, fixture.body, Some(7));
    if fixture.queued_push {
        super::queue::queue(&data, "note_body", NOTE, "update", "", 10);
    }
    drop(data);
    electron_db::seed(
        &Connection::open(&pair.index).unwrap(),
        "note_cache",
        &[
            ("id", text(NOTE)),
            ("path", text(PATH)),
            ("content_hash", text(&content_hash(fixture.read))),
        ],
    );
    let pending = match fixture.pending {
        Pending::None => None,
        Pending::UnstoredMark => Some("unstored-file".to_string()),
        Pending::File => Some(content_hash(fixture.file)),
    };
    if let Some(pending) = pending {
        Connection::open(&pair.index)
            .unwrap()
            .execute(
                "UPDATE note_cache SET pending_write_hash = ?1 WHERE id = ?2",
                [pending.as_str(), NOTE],
            )
            .unwrap();
    }
    e.write(PATH, fixture.file);

    let profile = electron_profile(e._dir.path());
    let lock = ProfileLock::probe(&profile).unwrap();
    let before = (electron_hashes(&pair.data), electron_hashes(&pair.index));
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let input = VaultImportInput {
        electron_closed: &lock,
        vault_dir: e.vault.clone(),
        vault_id: "vault-1".into(),
        electron_data_db: pair.data.clone(),
        electron_index_db: pair.index.clone(),
        docs: vec![doc],
        extra_owed_docs: Vec::new(),
        vault_key: None,
        electron_device_id: Some(ELECTRON_DEVICE.into()),
        now_ms,
        progress: None,
    };
    staged(stage_vault_import(input).unwrap())
        .install()
        .unwrap();
    assert_eq!(
        e.read(PATH),
        fixture.file,
        "the import writes no vault file"
    );
    drop(lock);

    e.open();
    e.facts_until(indexed);
    Settled {
        e,
        electron: [pair.data, pair.index],
        before,
    }
}

/// The RCA case: Yjs "B", file "A", cached hash of "A". The first session writes the body over
/// the file and keeps the file as a version.
#[test]
fn a_body_ahead_of_its_file_reaches_the_file_in_the_first_session() {
    let s = import_and_open(&AHEAD);
    s.until_file("B\n");
    assert_eq!(s.e.body(NOTE), "B");
    assert!(
        s.e.versions(NOTE).iter().any(|v| v.contains('A')),
        "{:?}",
        s.e.versions(NOTE)
    );
    s.electron_unchanged();
}

/// Electron's write-back failed (or the app was killed before it ran) with the body push still
/// queued: the body reaches the file and the push stays owed.
#[test]
fn a_failed_write_back_reaches_the_file_and_keeps_its_push() {
    let s = import_and_open(&Fixture {
        queued_push: true,
        ..AHEAD
    });
    s.until_file("B\n");
    assert!(s.e.versions(NOTE).iter().any(|v| v.contains('A')));
    let pushes: i64 =
        s.e.core()
            .db_handle()
            .call_blocking(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT count(*) FROM outbox WHERE item_id = ?1 AND op = 'crdt-update'",
                        [NOTE],
                        |row| row.get(0),
                    )
                    .unwrap())
            })
            .unwrap();
    assert!(pushes >= 1);
    s.electron_unchanged();
}

/// The file owes its body to the document: it is never written over. The open's take of the
/// owed file (`vault/consumer/tier/owed.rs`) puts the file into the body and keeps the body it
/// replaces as a version, once.
#[test]
fn a_file_that_owes_its_body_is_never_written_over() {
    let mut s = import_and_open(&Fixture {
        owed_file_body: true,
        ..AHEAD
    });
    assert_eq!(s.quiet_file(), "A\n");
    s.until_body("A");
    assert_eq!(s.e.versions(NOTE), vec!["B\n".to_string()]);
    s.electron_unchanged();
}

/// The file was edited while Electron was closed and the body was not ahead of what Electron
/// last read: the edit wins and reaches the body.
#[test]
fn an_outside_edit_after_quit_reaches_the_body() {
    let mut s = import_and_open(&Fixture {
        read: "A\n",
        file: "C\n",
        body: "A\n",
        ..AHEAD
    });
    let deadline = Instant::now() + WAIT;
    while s.e.body(NOTE) != "C" {
        assert!(Instant::now() < deadline, "body {:?}", s.e.body(NOTE));
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(s.quiet_file(), "C\n");
    s.electron_unchanged();
}

/// The body was ahead and the file was also edited while Electron was closed: the file wins,
/// as Electron's cached-hash guard feeds it (`crdt-writeback.ts:827-878`), and the body is kept
/// as a version first, so neither text is lost.
#[test]
fn an_outside_edit_beside_a_body_ahead_is_fed_and_the_body_kept() {
    let mut s = import_and_open(&Fixture {
        read: "A\n",
        file: "C\n",
        body: "B\n",
        ..AHEAD
    });
    s.until_body("C");
    assert_eq!(s.quiet_file(), "C\n");
    s.has_version('B');
    s.electron_unchanged();
}

/// An outside edit made while Electron was closed that also changed the frontmatter (a tag
/// added): the edit reaches the body, the file stays, and the body it replaced is a version.
#[test]
fn an_outside_edit_that_changed_the_frontmatter_reaches_the_body() {
    const FILE: &str = "---\ntags: [a, b]\n---\n\nC\n";
    let mut s = import_and_open(&Fixture {
        read: "---\ntags: [a]\n---\n\nA\n",
        file: FILE,
        body: "A\n",
        ..AHEAD
    });
    s.until_body("C");
    assert_eq!(s.quiet_file(), FILE);
    s.has_version('A');
    s.electron_unchanged();
}

/// The same edit saved by an editor that writes CRLF line ends.
#[test]
fn an_outside_edit_in_another_spelling_reaches_the_body() {
    const FILE: &str = "---\r\ntags: [a, b]\r\n---\r\n\r\nC\r\n";
    let mut s = import_and_open(&Fixture {
        read: "---\ntags: [a]\n---\n\nA\n",
        file: FILE,
        body: "A\n",
        ..AHEAD
    });
    s.until_body("C");
    assert_eq!(s.quiet_file(), FILE);
    s.has_version('A');
    s.electron_unchanged();
}

/// The body is its file: the row records the file's hash and nothing is written.
#[test]
fn a_body_equal_to_its_file_is_not_rewritten() {
    let mut s = import_and_open(&Fixture {
        body: "A\n",
        ..AHEAD
    });
    assert_eq!(s.quiet_file(), "A\n");
    assert_eq!(s.e.versions(NOTE), Vec::<String>::new());
    let hash: Option<String> =
        s.e.core()
            .db_handle()
            .call_blocking(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT content_hash FROM note_files WHERE note_id = ?1",
                        [NOTE],
                        |row| row.get(0),
                    )
                    .unwrap())
            })
            .unwrap();
    assert_eq!(hash, Some(content_hash("A\n")));
    s.electron_unchanged();
}

/// A file in Electron's spelling (frontmatter, a blank line, the body) whose body the document
/// holds: the first session writes nothing and keeps no version.
#[test]
fn a_file_with_frontmatter_whose_body_is_the_documents_is_not_rewritten() {
    const FILE: &str = "---\ntags: [a]\n---\n\nA\n";
    let mut s = import_and_open(&Fixture {
        read: FILE,
        file: FILE,
        body: "A\n",
        ..AHEAD
    });
    assert_eq!(s.quiet_file(), FILE);
    assert_eq!(s.e.versions(NOTE), Vec::<String>::new());
    s.electron_unchanged();
}

/// Electron's write-back marked the file unstored and the app quit before the store held the
/// doc it wrote: the file may hold typing the store lacks. Electron's open takes the file into
/// the doc (`takesUnstoredFile`, `writeback-baseline.ts`), so the import never writes the stored
/// body over it; the body it replaces is kept as a version.
#[test]
fn a_file_with_an_unstored_mark_is_taken_in_not_written_over() {
    let mut s = import_and_open(&Fixture {
        pending: Pending::UnstoredMark,
        ..AHEAD
    });
    assert_eq!(s.quiet_file(), "A\n");
    s.until_body("A");
    s.has_version('B');
    s.electron_unchanged();
}

/// Electron wrote "B" and quit before recording it, so only the pending hash names the file;
/// the store then took "C". The file is Electron's own write, not an outside edit: the body
/// reaches the file and the file is kept as a version, as Electron's `isOutsideEdit` reads it.
#[test]
fn a_file_under_a_plain_pending_hash_is_the_baseline() {
    let s = import_and_open(&Fixture {
        read: "A\n",
        file: "B\n",
        body: "C\n",
        pending: Pending::File,
        ..AHEAD
    });
    s.until_file("C\n");
    assert_eq!(s.e.body(NOTE), "C");
    s.has_version('B');
    s.electron_unchanged();
}

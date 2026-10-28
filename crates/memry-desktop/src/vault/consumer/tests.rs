//! The consumer's invariants (module docs), one fact at a time, over a real `data.db`, real
//! files and the real feed. Each trigger that hands a file to the consumer is here: a watcher
//! `Added` or `Changed`, the open walk, a note whose body is owed by sync, a body synced
//! before the file was seen, and a row the app reserved.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{BODY_FRAGMENT, DocumentRegistry, update_log};
use memry_core::crypto::sodium;
use memry_core::domain::external_feed::FeedInput;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::OpenOptions;
use tokio::sync::broadcast;

use super::apply::{Applier, Step};
use super::identity::{Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal};
use super::rows::{RowOwner, RowStat};
use super::{Applied, ChangeSource};
use crate::profile_store::ProfileDeviceKeyStore;
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::watch::VaultEvent;

/// Creates a note per new file, deletes the record on removal, and records what it saw.
struct Recorder {
    writer: Arc<NotesWriter>,
    /// The answer of the next `adopt_or_create`, instead of a new note.
    next: Mutex<Option<Adoption>>,
    fail: AtomicBool,
    removal: Mutex<Removal>,
    adopted: Mutex<Vec<String>>,
    /// Whether the note's row was still there when the record was deleted.
    row_at_delete: Mutex<Vec<bool>>,
    /// The row's path when `on_renamed` ran.
    row_at_rename: Mutex<Vec<String>>,
}

impl NoteIdentity for Recorder {
    fn adopt_or_create(
        &self,
        _: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        self.adopted.lock().unwrap().push(file.path.to_owned());
        if self.fail.load(Ordering::SeqCst) {
            return Err(IdentityError::Other("no".into()));
        }
        if let Some(answer) = self.next.lock().unwrap().take() {
            return Ok(answer);
        }
        Ok(Adoption::Created(
            self.writer.create(file.path.into(), None)?,
        ))
    }

    fn on_removed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        _: &str,
    ) -> Result<Removal, IdentityError> {
        let row = ctx.vault.note_files().by_id(note_id)?;
        self.row_at_delete.lock().unwrap().push(row.is_some());
        let removal = *self.removal.lock().unwrap();
        if removal == Removal::Deleted {
            self.writer.delete(note_id.into())?;
        }
        Ok(removal)
    }

    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        _: &str,
        _: &str,
    ) -> Result<(), IdentityError> {
        let row = ctx.vault.note_files().by_id(note_id)?.expect("the row");
        self.row_at_rename.lock().unwrap().push(row.path);
        Ok(())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    vault: Arc<Vault>,
    store: Arc<dyn SecureStore>,
    rows: Arc<RowOwner>,
    identity: Arc<Recorder>,
    facts: broadcast::Receiver<Applied>,
    applier: Applier,
}

fn fixture(feed_changes: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let store = ProfileDeviceKeyStore::shared(&dir.path().join("app"));
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    let vault = Arc::new(
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap(),
    );
    let rows = RowOwner::new();
    rows.open(vault.note_files()).unwrap();
    let identity = Arc::new(Recorder {
        writer: vault.notes_writer(store.clone()).unwrap(),
        next: Mutex::default(),
        fail: AtomicBool::new(false),
        removal: Mutex::new(Removal::Deleted),
        adopted: Mutex::default(),
        row_at_delete: Mutex::default(),
        row_at_rename: Mutex::default(),
    });
    let applier = Applier {
        root: root.clone(),
        vault: vault.clone(),
        rows: rows.clone(),
        identity: identity.clone(),
        feed: vault.external_feed(store.clone()).ok(),
        settings: vault.app_settings(store.clone()).ok(),
        feed_changes,
    };
    Fixture {
        facts: rows.subscribe(),
        _dir: dir,
        root,
        vault,
        store,
        rows,
        identity,
        applier,
    }
}

impl Fixture {
    fn write(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn added(&self, rel: &str) -> Step {
        let meta = std::fs::metadata(self.root.join(rel)).unwrap();
        self.applier.apply(VaultEvent::Added {
            path: rel.into(),
            file_type: FileType::Markdown,
            size: meta.len(),
            modified_ms: 0,
            content_hash: None,
        })
    }

    fn walked(&self, rel: &str) -> Step {
        let meta = std::fs::symlink_metadata(self.root.join(rel)).unwrap();
        self.applier.walked(rel, &meta)
    }

    fn changed(&self, note_id: &str, rel: &str) -> Step {
        let meta = std::fs::metadata(self.root.join(rel)).unwrap();
        self.applier.apply(VaultEvent::Changed {
            note_id: note_id.into(),
            path: rel.into(),
            content_hash: None,
            size: meta.len(),
            modified_ms: i64::MAX,
        })
    }

    fn row(&self, rel: &str) -> Option<memry_core::domain::note_files::NoteFile> {
        self.vault.note_files().by_path(rel).unwrap()
    }

    fn hash_of(&self, rel: &str) -> Option<String> {
        self.row(rel).expect("a row").content_hash
    }

    fn note(&self) -> String {
        self.identity.writer.create("Synced".into(), None).unwrap()
    }

    fn adopted(&self) -> Vec<String> {
        self.identity.adopted.lock().unwrap().clone()
    }

    fn facts(&mut self) -> Vec<Applied> {
        std::iter::from_fn(|| self.facts.try_recv().ok()).collect()
    }

    /// The note's body as a replay of its durable log renders it.
    fn body(&self, id: &str) -> String {
        let sink: UpdateSink = Arc::new(|_, _| {});
        let document = DocumentRegistry::new("reader", sink)
            .get_or_open(id)
            .unwrap();
        let id = id.to_owned();
        self.vault
            .db_handle()
            .call_blocking(move |conn| {
                for blob in update_log::load_plan(conn, &id).unwrap().blobs() {
                    document.apply_durable_update(blob).unwrap();
                }
                Ok(document)
            })
            .map(|document| {
                Converter::new(CalloutTypes::new(Vec::new()))
                    .doc_to_canonical_markdown(&document, BODY_FRAGMENT)
                    .unwrap_or_default()
            })
            .unwrap()
    }

    /// A body that reached the note another way (sync, the app's editor).
    fn give_body(&self, id: &str, text: &str) {
        let input = FeedInput {
            note_id: id,
            markdown: text,
            note_path: None,
            writing: None,
            frontmatter: None,
        };
        self.vault
            .external_feed(self.store.clone())
            .unwrap()
            .feed(&Converter::new(CalloutTypes::new(Vec::new())), input)
            .unwrap();
    }

    /// The note's server body has not arrived (`sync::body_debt`).
    fn owe_server_body(&self, id: &str) {
        let key = format!("sync.body_owed:{id}");
        self.vault
            .db_handle()
            .call_blocking(move |conn| {
                conn.execute("INSERT INTO meta (key, value) VALUES (?1, '0:0')", [key])
                    .unwrap();
                Ok(())
            })
            .unwrap();
    }
}

fn only_note(f: &Fixture, rel: &str) -> String {
    f.row(rel).expect("a row").note_id
}

#[test]
fn a_new_file_gets_a_note_seeded_with_its_text_and_a_row_naming_that_text() {
    let mut f = fixture(false);
    f.write("a.md", "hello from outside\n");
    assert_eq!(f.added("a.md"), Step::Done);
    let id = only_note(&f, "a.md");
    assert!(
        f.body(&id).contains("hello from outside"),
        "{}",
        f.body(&id)
    );
    assert_eq!(
        f.hash_of("a.md"),
        Some(content_hash("hello from outside\n"))
    );
    assert_eq!(
        f.facts(),
        vec![Applied::Added {
            note_id: id,
            path: "a.md".into(),
            created: true
        }]
    );
}

#[test]
fn a_file_the_walk_and_a_watcher_report_both_offer_gets_one_note() {
    let f = fixture(false);
    f.write("a.md", "one note\n");
    assert_eq!(f.walked("a.md"), Step::Done);
    let id = only_note(&f, "a.md");
    // The watcher's `Added` was queued before the walk recorded the row.
    assert_eq!(f.added("a.md"), Step::Done);
    assert_eq!(f.walked("a.md"), Step::Done);
    assert_eq!(
        f.adopted(),
        vec!["a.md".to_owned()],
        "a second note was made"
    );
    assert_eq!(only_note(&f, "a.md"), id);
    assert_eq!(
        f.body(&id).matches("one note").count(),
        1,
        "{}",
        f.body(&id)
    );
}

/// A file the walk recorded and a writer then rewrote is reported `Added` after the walk
/// (its grace restarted): that is a change of the walked file's note, not a file to drop.
#[test]
fn a_late_added_for_a_file_that_has_a_row_is_a_change_of_its_note() {
    let f = fixture(true);
    f.write("a.md", "walked\n");
    assert_eq!(f.walked("a.md"), Step::Done);
    let id = only_note(&f, "a.md");
    f.write("a.md", "rewritten after the walk\n");
    assert_eq!(f.added("a.md"), Step::Done);
    assert!(
        f.body(&id).contains("rewritten after the walk"),
        "{}",
        f.body(&id)
    );
    assert_eq!(
        f.hash_of("a.md"),
        Some(content_hash("rewritten after the walk\n"))
    );
    assert_eq!(f.adopted().len(), 1);
}

#[test]
fn a_row_the_app_reserved_makes_the_watchers_added_a_change_of_that_note() {
    let mut f = fixture(false);
    let id = f.note();
    f.rows
        .reserve(
            &id,
            "made-in-app.md",
            RowStat {
                file_type: FileType::Markdown,
                size: 0,
                content_hash: None,
            },
        )
        .unwrap();
    f.write("made-in-app.md", "written by the app\n");
    assert_eq!(f.added("made-in-app.md"), Step::Done);
    assert!(f.adopted().is_empty(), "the app's file got a second note");
    assert_eq!(only_note(&f, "made-in-app.md"), id);
    assert_eq!(
        f.facts(),
        vec![Applied::Added {
            note_id: id,
            path: "made-in-app.md".into(),
            created: true
        }]
    );
}

#[test]
fn a_note_whose_server_body_is_owed_gets_a_row_without_a_hash() {
    let f = fixture(false);
    let id = f.note();
    f.owe_server_body(&id);
    *f.identity.next.lock().unwrap() = Some(Adoption::Existing(id.clone()));
    f.write("synced.md", "an older copy of the file\n");
    assert_eq!(f.added("synced.md"), Step::Done);
    assert_eq!(only_note(&f, "synced.md"), id);
    assert_eq!(
        f.hash_of("synced.md"),
        None,
        "an owed note's file was taken as read"
    );
    assert!(f.vault.note_files().owes_file_body(&id).unwrap());
    assert!(!f.body(&id).contains("older copy"), "{}", f.body(&id));
}

#[test]
fn a_body_that_arrived_before_the_file_is_not_taken_for_the_files_text() {
    let f = fixture(false);
    let id = f.note();
    f.give_body(&id, "the synced body");
    *f.identity.next.lock().unwrap() = Some(Adoption::Existing(id.clone()));
    f.write("synced.md", "what the file says\n");
    assert_eq!(f.added("synced.md"), Step::Done);
    assert_eq!(
        f.hash_of("synced.md"),
        None,
        "a body left alone was recorded as holding the file"
    );
    assert!(f.body(&id).contains("the synced body"));
}

#[test]
fn a_crash_between_create_and_seed_is_seeded_when_the_note_is_adopted_again() {
    let f = fixture(false);
    let id = f.note();
    *f.identity.next.lock().unwrap() = Some(Adoption::Existing(id.clone()));
    f.write("a.md", "seeded late\n");
    assert_eq!(f.added("a.md"), Step::Done);
    assert!(f.body(&id).contains("seeded late"));
    assert_eq!(f.hash_of("a.md"), Some(content_hash("seeded late\n")));
}

#[test]
fn a_changed_file_is_not_fed_while_outside_edits_wait_for_the_write_back() {
    let mut f = fixture(false);
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    f.write("a.md", "edited outside\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(f.body(&id).contains("first") && !f.body(&id).contains("edited"));
    assert_eq!(f.hash_of("a.md"), Some(content_hash("first\n")));
    assert!(f.facts().is_empty());
}

#[test]
fn a_changed_file_is_fed_and_its_hash_recorded_once_feeding_is_on() {
    let mut f = fixture(true);
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    f.write("a.md", "edited outside\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(f.body(&id).contains("edited outside"));
    let hash = content_hash("edited outside\n");
    assert_eq!(f.hash_of("a.md"), Some(hash.clone()));
    assert_eq!(
        f.facts(),
        vec![Applied::Changed {
            note_id: id,
            path: "a.md".into(),
            content_hash: Some(hash),
            source: ChangeSource::Watcher
        }]
    );
}

#[test]
fn a_changed_file_whose_note_owes_its_body_keeps_the_hash_the_document_holds() {
    let f = fixture(true);
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.owe_server_body(&id);
    f.write("a.md", "edited outside\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert_eq!(f.hash_of("a.md"), Some(content_hash("first\n")));
    // The walk at the next open does not take it for read either.
    assert_eq!(f.walked("a.md"), Step::Done);
    assert_eq!(f.hash_of("a.md"), Some(content_hash("first\n")));
}

/// A file whose text did not reach its note (here: the server body was owed) is read again by
/// the next open's walk, although its size and time say nothing changed.
#[test]
fn the_walk_reads_again_a_file_whose_text_never_reached_its_note() {
    let f = fixture(true);
    let id = f.note();
    f.owe_server_body(&id);
    *f.identity.next.lock().unwrap() = Some(Adoption::Existing(id.clone()));
    f.write("a.md", "the file\n");
    assert_eq!(f.added("a.md"), Step::Done);
    assert_eq!(f.hash_of("a.md"), None);
    let key = format!("sync.body_owed:{id}");
    f.vault
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute("DELETE FROM meta WHERE key = ?1", [key])
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(f.walked("a.md"), Step::Done);
    assert_eq!(f.hash_of("a.md"), Some(content_hash("the file\n")));
    assert!(f.body(&id).contains("the file"));
}

#[test]
fn a_file_that_is_another_notes_file_on_a_case_insensitive_volume_gets_no_note() {
    let f = fixture(false);
    f.write("Note.md", "mine\n");
    f.added("Note.md");
    let id = only_note(&f, "Note.md");
    // `NOTE.md` names the same file on APFS and NTFS; on a case-sensitive volume it is a
    // second file, which is refused rather than risk a write-back over the first.
    f.write("NOTE.md", "mine\n");
    assert_eq!(f.added("NOTE.md"), Step::Done);
    assert_eq!(f.adopted(), vec!["Note.md".to_owned()]);
    assert_eq!(f.vault.note_files().list_paths().unwrap().len(), 1);
    assert_eq!(only_note(&f, "Note.md"), id);
}

#[test]
fn a_removed_files_row_goes_only_after_its_record_was_deleted() {
    let mut f = fixture(false);
    f.write("a.md", "x\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    *f.identity.removal.lock().unwrap() = Removal::Kept;
    let removed = VaultEvent::Removed {
        note_id: id.clone(),
        path: "a.md".into(),
    };
    assert_eq!(f.applier.apply(removed.clone()), Step::Done);
    assert!(f.row("a.md").is_some(), "a kept note lost its row");
    assert!(f.facts().is_empty());

    *f.identity.removal.lock().unwrap() = Removal::Deleted;
    assert_eq!(f.applier.apply(removed.clone()), Step::Done);
    assert_eq!(*f.identity.row_at_delete.lock().unwrap(), vec![true, true]);
    assert!(f.row("a.md").is_none());
    assert_eq!(
        f.facts(),
        vec![Applied::Removed {
            note_id: id,
            path: "a.md".into()
        }]
    );
    // Applied again (a repeated report), it asks nothing.
    assert_eq!(f.applier.apply(removed), Step::Done);
    assert_eq!(f.identity.row_at_delete.lock().unwrap().len(), 2);
}

#[test]
fn a_moved_files_row_moves_before_the_record_is_told() {
    let mut f = fixture(false);
    f.write("a.md", "x\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    let renamed = VaultEvent::Renamed {
        note_id: id.clone(),
        old_path: "a.md".into(),
        new_path: "dir/b.md".into(),
        content_hash: None,
    };
    assert_eq!(f.applier.apply(renamed.clone()), Step::Done);
    assert_eq!(only_note(&f, "dir/b.md"), id);
    assert_eq!(
        *f.identity.row_at_rename.lock().unwrap(),
        vec!["dir/b.md".to_owned()]
    );
    assert_eq!(f.facts().len(), 1);
    assert_eq!(f.applier.apply(renamed), Step::Done);
    assert_eq!(
        f.identity.row_at_rename.lock().unwrap().len(),
        1,
        "a repeat told it twice"
    );
}

#[test]
fn a_file_whose_note_could_not_be_named_is_retried_and_then_gets_one_note() {
    let f = fixture(false);
    f.write("a.md", "x\n");
    f.identity.fail.store(true, Ordering::SeqCst);
    assert_eq!(f.added("a.md"), Step::Retry("a.md".into()));
    assert!(f.row("a.md").is_none());
    f.identity.fail.store(false, Ordering::SeqCst);
    assert_eq!(f.added("a.md"), Step::Done);
    assert!(f.row("a.md").is_some());
}

#[test]
fn a_file_whose_text_could_not_reach_its_note_gets_no_row_and_is_retried() {
    let mut f = fixture(false);
    f.applier.feed = None;
    f.write("a.md", "x\n");
    assert_eq!(f.added("a.md"), Step::Retry("a.md".into()));
    assert!(
        f.row("a.md").is_none(),
        "a row without the seed it promised"
    );
    assert!(f.facts().is_empty());
}

#[test]
fn a_deferred_file_gets_no_row_and_no_retry() {
    let mut f = fixture(false);
    *f.identity.next.lock().unwrap() = Some(Adoption::Defer);
    f.write("a.md", "x\n");
    assert_eq!(f.added("a.md"), Step::Done);
    assert!(f.row("a.md").is_none());
    assert!(f.facts().is_empty());
}

#[test]
fn nothing_is_applied_once_the_vault_closed() {
    let f = fixture(false);
    f.rows.close();
    f.write("a.md", "x\n");
    assert_eq!(f.added("a.md"), Step::Done);
    assert!(f.adopted().is_empty());
    assert!(f.row("a.md").is_none());
}

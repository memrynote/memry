//! The consumer's invariants (module docs), one fact at a time, over a real `data.db`, real
//! files and the real feed. Each trigger that hands a file to the consumer is here: a watcher
//! `Added` or `Changed`, the open walk, a note whose body is owed by sync, a body synced
//! before the file was seen, and a row the app reserved.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{BODY_FRAGMENT, DocumentRegistry, update_log};
use memry_core::crypto::sodium;
use memry_core::domain::external_feed::FeedInput;
use memry_core::domain::notes::identity::FileNote;
use memry_core::domain::notes::new_files::NewFileNote;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::OpenOptions;
use tokio::sync::broadcast;

use super::apply::{Applier, Step};
use super::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NewFile, NoteIdentity, Removal, Rename,
};
use super::rows::{RowOwner, RowSession, RowStat};
use super::walked::Walked;
use super::{Applied, ChangeSource};
use crate::vault::activity::ScanActivity;
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::watch::VaultEvent;

/// A device signing key held in memory: the device identity without the OS keychain.
#[derive(Default)]
struct MemoryStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

/// A store holding this device's signing key.
pub(crate) fn with_device_key() -> Arc<dyn SecureStore> {
    let store = MemoryStore::default();
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    Arc::new(store)
}

/// Creates a note per new file, deletes the record on removal, and records what it saw.
pub(super) struct Recorder {
    pub(super) writer: Arc<NotesWriter>,
    /// The answer of the next `adopt_or_create`, instead of a new note.
    pub(super) next: Mutex<Option<Adoption>>,
    pub(super) fail: AtomicBool,
    /// [`NoteIdentity::adopts`].
    pub(super) adopts: AtomicBool,
    pub(super) rename_fails: AtomicBool,
    /// Runs inside the next `adopt_or_create`.
    pub(super) during_adopt: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    pub(super) removal: Mutex<Removal>,
    pub(super) adopted: Mutex<Vec<String>>,
    /// Whether the note's row was still there when the record was deleted.
    pub(super) row_at_delete: Mutex<Vec<bool>>,
    /// The row's path when `on_renamed` ran.
    pub(super) row_at_rename: Mutex<Vec<String>>,
    /// `(note_id, previous)` of every `on_changed`.
    pub(super) changed: Mutex<Vec<(String, String)>>,
    pub(super) changed_fails: AtomicBool,
    /// What `adopt_new_files` does; [`Batch::Off`] leaves every new file to `adopt_or_create`.
    pub(super) batch: Mutex<Batch>,
}

/// How [`Recorder`] answers for new files applied together.
#[derive(Clone, Default)]
pub(super) enum Batch {
    #[default]
    Off,
    /// Creates every file's note with its body, in one transaction.
    Create,
    /// Answers an error.
    Fail,
    /// Creates them, then gives another note a row at this path, so their rows cannot be
    /// written together.
    CreateThenTake(String),
}

impl NoteIdentity for Recorder {
    fn adopts(&self) -> bool {
        self.adopts.load(Ordering::SeqCst)
    }

    fn adopt_or_create(
        &self,
        _: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        self.adopted.lock().unwrap().push(file.path.to_owned());
        let during = self.during_adopt.lock().unwrap().take();
        if let Some(during) = during {
            during();
        }
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

    fn may_be_new(&self, _: &IdentityCtx<'_>, files: &[Candidate<'_>]) -> Vec<bool> {
        let together = !matches!(*self.batch.lock().unwrap(), Batch::Off);
        vec![together; files.len()]
    }

    fn adopt_new_files(
        &self,
        ctx: &IdentityCtx<'_>,
        files: &[NewFile<'_>],
    ) -> Result<Vec<bool>, IdentityError> {
        let batch = self.batch.lock().unwrap().clone();
        if matches!(batch, Batch::Fail) {
            return Err(IdentityError::Other("the batch failed".into()));
        }
        let notes: Vec<NewFileNote<'_>> = files
            .iter()
            .map(|new| NewFileNote {
                file: FileNote {
                    path: new.candidate.path,
                    title: new.candidate.path.trim_end_matches(".md"),
                    folder_path: None,
                    body: new.candidate.file.expect("read").split().body,
                    created_ms: new.candidate.modified_ms,
                    modified_ms: new.candidate.modified_ms,
                    electron_db_beside: false,
                },
                id: new.id,
                body: new.body,
            })
            .collect();
        let created = self
            .writer
            .adopt_new_files(&notes)
            .map_err(|error| IdentityError::Other(error.to_string()))?;
        if let Batch::CreateThenTake(path) = batch {
            let other = self.writer.create("Other".into(), None)?;
            ctx.vault
                .note_files()
                .upsert_stat(memry_core::domain::note_files::NoteFileStat {
                    note_id: other,
                    path,
                    file_type: "markdown".into(),
                    mime_type: None,
                    file_size: Some(1),
                    content_hash: None,
                    file_hash: None,
                    indexed_at: 0,
                })?;
        }
        Ok(created)
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
    ) -> Result<Rename, IdentityError> {
        let row = ctx.vault.note_files().by_id(note_id)?.expect("the row");
        self.row_at_rename.lock().unwrap().push(row.path);
        if self.rename_fails.load(Ordering::SeqCst) {
            return Err(IdentityError::Other("the record did not move".into()));
        }
        Ok(Rename::Followed)
    }

    fn on_changed(
        &self,
        _: &IdentityCtx<'_>,
        note_id: &str,
        previous: &str,
        _: &crate::vault::note_file::NoteFile,
    ) -> Result<(), IdentityError> {
        self.changed
            .lock()
            .unwrap()
            .push((note_id.to_owned(), previous.to_owned()));
        if self.changed_fails.load(Ordering::SeqCst) {
            return Err(IdentityError::Other("the record did not take it".into()));
        }
        Ok(())
    }
}

pub(super) struct Fixture {
    pub(super) _dir: tempfile::TempDir,
    pub(super) root: PathBuf,
    pub(super) vault: Arc<Vault>,
    pub(super) store: Arc<dyn SecureStore>,
    pub(super) rows: Arc<RowOwner>,
    pub(super) identity: Arc<Recorder>,
    pub(super) facts: broadcast::Receiver<Applied>,
    pub(super) applier: Applier,
}

pub(super) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let store = with_device_key();
    let vault = Arc::new(
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap(),
    );
    let rows = RowOwner::new();
    rows.open(vault.clone()).unwrap();
    let identity = Arc::new(Recorder {
        writer: vault.notes_writer(store.clone()).unwrap(),
        next: Mutex::default(),
        fail: AtomicBool::new(false),
        adopts: AtomicBool::new(true),
        rename_fails: AtomicBool::new(false),
        during_adopt: Mutex::default(),
        removal: Mutex::new(Removal::Deleted),
        adopted: Mutex::default(),
        row_at_delete: Mutex::default(),
        row_at_rename: Mutex::default(),
        changed: Mutex::default(),
        changed_fails: AtomicBool::new(false),
        batch: Mutex::default(),
    });
    let applier = applier(&root, &vault, &store, &rows, identity.clone());
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
    pub(super) fn write(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    pub(super) fn added(&self, rel: &str) -> Step {
        let meta = std::fs::metadata(self.root.join(rel)).unwrap();
        self.applier.apply(VaultEvent::Added {
            path: rel.into(),
            file_type: FileType::Markdown,
            size: meta.len(),
            modified_ms: 0,
            content_hash: None,
        })
    }

    pub(super) fn walked(&self, rel: &str) -> Step {
        self.walk_one(rel, &mut ScanActivity::default())
    }

    /// The open walk's step for the one file `rel`: a new markdown file it puts aside is
    /// applied as the walk's end applies what it put aside.
    pub(super) fn walk_one(&self, rel: &str, scan: &mut ScanActivity) -> Step {
        let meta = std::fs::symlink_metadata(self.root.join(rel)).unwrap();
        match self.applier.walked(rel, &meta, scan) {
            Walked::Applied(step) => step,
            Walked::New(file) => {
                let mut together = self.applier.found_together(vec![file], scan);
                match together.alone.pop() {
                    Some(file) => self.applier.found_alone(file, scan),
                    None => together.steps.remove(0).1,
                }
            }
        }
    }

    /// The open walk's steps for the new files `rels`, applied together as the walk applies
    /// what it put aside, the files sent back each alone.
    pub(super) fn walk_together(&self, rels: &[&str]) -> Vec<(String, Step)> {
        let mut scan = ScanActivity::default();
        let found = rels
            .iter()
            .map(|rel| {
                let meta = std::fs::symlink_metadata(self.root.join(rel)).unwrap();
                match self.applier.walked(rel, &meta, &mut scan) {
                    Walked::New(file) => file,
                    Walked::Applied(_) => panic!("{rel} is not a new file"),
                }
            })
            .collect();
        let together = self.applier.found_together(found, &mut scan);
        let mut steps = together.steps;
        for file in together.alone {
            let path = file.path.clone();
            steps.push((path, self.applier.found_alone(file, &mut scan)));
        }
        steps.sort_by(|a, b| a.0.cmp(&b.0));
        steps
    }

    pub(super) fn changed(&self, note_id: &str, rel: &str) -> Step {
        let meta = std::fs::metadata(self.root.join(rel)).unwrap();
        self.applier.apply(VaultEvent::Changed {
            note_id: note_id.into(),
            path: rel.into(),
            content_hash: None,
            size: meta.len(),
            modified_ms: i64::MAX,
        })
    }

    pub(super) fn row(&self, rel: &str) -> Option<memry_core::domain::note_files::NoteFile> {
        self.vault.note_files().by_path(rel).unwrap()
    }

    pub(super) fn hash_of(&self, rel: &str) -> Option<String> {
        self.row(rel).expect("a row").content_hash
    }

    pub(super) fn note(&self) -> String {
        self.identity.writer.create("Synced".into(), None).unwrap()
    }

    pub(super) fn session(&self) -> RowSession {
        self.rows.session_for(&self.vault).unwrap()
    }

    pub(super) fn stat(size: u64) -> RowStat {
        RowStat {
            file_type: FileType::Markdown,
            size,
            content_hash: None,
            file_hash: None,
        }
    }

    pub(super) fn adopted(&self) -> Vec<String> {
        self.identity.adopted.lock().unwrap().clone()
    }

    pub(super) fn facts(&mut self) -> Vec<Applied> {
        std::iter::from_fn(|| self.facts.try_recv().ok()).collect()
    }

    /// The versions kept for the note.
    pub(super) fn versions(&self, id: &str) -> Vec<String> {
        let id = id.to_owned();
        self.vault
            .db_handle()
            .call_blocking(move |conn| {
                let mut statement = conn
                    .prepare("SELECT content FROM note_snapshots WHERE note_id = ?1")
                    .unwrap();
                Ok(statement
                    .query_map([id], |row| row.get(0))
                    .unwrap()
                    .collect::<Result<Vec<String>, _>>()
                    .unwrap())
            })
            .unwrap()
    }

    /// The note's body as a replay of its durable log renders it.
    pub(super) fn body(&self, id: &str) -> String {
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
    pub(super) fn give_body(&self, id: &str, text: &str) {
        let input = FeedInput {
            note_id: id,
            markdown: text,
            note_path: None,
            writing: None,
            frontmatter: None,
            embeds: None,
        };
        self.vault
            .external_feed(self.store.clone())
            .unwrap()
            .feed(&Converter::new(CalloutTypes::new(Vec::new())), input)
            .unwrap();
    }

    /// The note's server body has not arrived (`sync::body_debt`).
    pub(super) fn owe_server_body(&self, id: &str) {
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

pub(super) fn applier(
    root: &std::path::Path,
    vault: &Arc<Vault>,
    store: &Arc<dyn SecureStore>,
    rows: &Arc<RowOwner>,
    identity: Arc<dyn NoteIdentity>,
) -> Applier {
    Applier {
        root: root.to_owned(),
        vault: vault.clone(),
        search: vault.search().unwrap(),
        rows: rows.clone(),
        identity,
        feed: vault.external_feed(store.clone()).ok(),
        settings: vault.app_settings(store.clone()).ok(),
        session: rows.session_for(vault).unwrap(),
        activity: crate::vault::activity::ActivityLog::new(),
        own_files: Arc::default(),
        watch: None,
        untaken: Mutex::default(),
    }
}

pub(super) fn only_note(f: &Fixture, rel: &str) -> String {
    f.row(rel).expect("a row").note_id
}

mod activity;
mod batch;
mod embeds;
mod facts;
mod flood;
mod hash_rule;
mod lane;
mod late_close;
mod outside_edit;
#[cfg(windows)]
mod replace_race;
mod slow_watch_stop;

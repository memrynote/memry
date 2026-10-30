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
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::OpenOptions;
use tokio::sync::broadcast;

use super::apply::{Applier, Step};
use super::identity::{Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal};
use super::rows::{RowOwner, RowSession, RowStat};
use super::{Applied, ChangeSource};
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
        if self.rename_fails.load(Ordering::SeqCst) {
            return Err(IdentityError::Other("the record did not move".into()));
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
        let meta = std::fs::symlink_metadata(self.root.join(rel)).unwrap();
        self.applier.walked(rel, &meta)
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
        rows: rows.clone(),
        identity,
        feed: vault.external_feed(store.clone()).ok(),
        settings: vault.app_settings(store.clone()).ok(),
        session: rows.session_for(vault).unwrap(),
    }
}

pub(super) fn only_note(f: &Fixture, rel: &str) -> String {
    f.row(rel).expect("a row").note_id
}

mod facts;
mod flood;
mod hash_rule;
mod lane;
mod late_close;
#[cfg(windows)]
mod replace_race;

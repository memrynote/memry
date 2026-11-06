//! A vault on a real SQLite file with its `Editor`, and a window's replica of a
//! document, for the editor host tests (Step 14a).

use std::path::Path;
use std::sync::Arc;

use memry_core::api::editor::Editor;
use memry_core::api::journal::Journal;
use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use rusqlite::params;
use yrs::updates::decoder::Decode as _;
use yrs::updates::encoder::Encode as _;
use yrs::{
    Doc, GetString as _, Map as _, MapRef, ReadTxn as _, StateVector, Text as _, Transact as _,
    Update, XmlFragment as _, XmlFragmentRef, XmlTextPrelim,
};

use crate::http_fakes::FakeSecureStore;

pub struct Fixture {
    pub dir: tempfile::TempDir,
    pub vault: Vault,
    pub editor: Arc<Editor>,
    pub writer: Arc<NotesWriter>,
    pub journal: Arc<Journal>,
    pub store: Arc<FakeSecureStore>,
}

pub fn fixture() -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("memry-editor-")
        .tempdir()
        .expect("the scratch directory");
    open_at(dir)
}

/// The vault at `dir`, opened again: a relaunch.
pub fn open_at(dir: tempfile::TempDir) -> Fixture {
    let vault = Vault::open("vault-1".to_owned(), dir.path().display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[7u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let editor = vault.editor(store.clone()).expect("an editor");
    let writer = vault.notes_writer(store.clone()).expect("a writer");
    let journal = vault.journal(store.clone()).expect("a journal");
    Fixture {
        dir,
        vault,
        editor,
        writer,
        journal,
        store,
    }
}

impl Fixture {
    pub fn note(&self) -> String {
        self.writer.create("A note".into(), None).expect("create")
    }

    /// The vault closed and opened again on the same files.
    pub fn relaunch(self) -> Fixture {
        let Fixture { dir, .. } = self;
        open_at(dir)
    }

    /// The bytes of every local update row of `note_id`, oldest first.
    pub fn local_blobs(&self, note_id: &str) -> Vec<Vec<u8>> {
        local_blobs(self.dir.path(), note_id)
    }

    /// How many `crdt-update` outbox rows `note_id` has.
    pub fn queued(&self, note_id: &str) -> i64 {
        self.query(
            "SELECT COUNT(*) FROM outbox WHERE item_id = ?1 AND op = 'crdt-update'",
            note_id,
        )
    }

    /// The item types of `note_id`'s `crdt-update` outbox rows.
    pub fn queued_types(&self, note_id: &str) -> Vec<String> {
        self.vault
            .db_handle()
            .read_blocking(|conn| {
                let mut statement = conn
                    .prepare(
                        "SELECT item_type FROM outbox WHERE item_id = ?1 AND op = 'crdt-update'",
                    )
                    .expect("prepare");
                Ok(statement
                    .query_map(params![note_id], |row| row.get(0))
                    .expect("query")
                    .collect::<Result<_, _>>()
                    .expect("rows"))
            })
            .expect("read")
    }

    fn query(&self, sql: &str, note_id: &str) -> i64 {
        self.vault
            .db_handle()
            .read_blocking(|conn| {
                Ok(conn
                    .query_row(sql, params![note_id], |row| row.get(0))
                    .expect("count"))
            })
            .expect("read")
    }
}

/// Read through a connection of its own, so a caller inside a listener sees
/// exactly what was committed.
pub fn local_blobs(dir: &Path, note_id: &str) -> Vec<Vec<u8>> {
    let conn = rusqlite::Connection::open(dir.join("data.db")).expect("a reader");
    let mut statement = conn
        .prepare("SELECT update_blob FROM yjs_updates WHERE doc_id = ?1 ORDER BY seq")
        .expect("prepare");
    statement
        .query_map(params![format!("local.{note_id}")], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// A window's copy of a document, as the renderer's Yjs doc holds it.
pub struct Replica {
    doc: Doc,
    body: XmlFragmentRef,
    foreign: MapRef,
}

impl Replica {
    pub fn new(client_id: u64) -> Self {
        let doc = Doc::with_client_id(client_id);
        let body = doc.get_or_insert_xml_fragment("prosemirror");
        let foreign = doc.get_or_insert_map("someFutureRoot");
        Self { doc, body, foreign }
    }

    pub fn from_state(client_id: u64, state: &[u8]) -> Self {
        let replica = Self::new(client_id);
        replica.apply(state);
        replica
    }

    pub fn apply(&self, update: &[u8]) {
        self.doc
            .transact_mut()
            .apply_update(Update::decode_v1(update).expect("decode"))
            .expect("apply");
    }

    /// Appends `text` to the body; returns the update that edit made.
    pub fn type_text(&self, text: &str) -> Vec<u8> {
        self.edit(|txn| {
            let end = self.body.len(txn);
            self.body.insert(txn, end, XmlTextPrelim::new(text));
        })
    }

    /// Sets `key` in a root no build names yet.
    pub fn set_foreign(&self, key: &str, value: &str) -> Vec<u8> {
        self.edit(|txn| {
            self.foreign.insert(txn, key, value);
        })
    }

    /// Deletes the first `len` characters of the body's first text.
    pub fn delete_first(&self, len: u32) -> Vec<u8> {
        self.edit(|txn| {
            let text = self
                .body
                .get(txn, 0)
                .and_then(|node| node.into_xml_text())
                .expect("a text node");
            text.remove_range(txn, 0, len);
        })
    }

    /// The whole state, as a renderer's sync step 2 sends it.
    pub fn full_state(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    pub fn text(&self) -> String {
        self.body.get_string(&self.doc.transact())
    }

    pub fn foreign(&self, key: &str) -> Option<String> {
        let txn = self.doc.transact();
        self.foreign
            .get(&txn, key)
            .map(|value| value.to_string(&txn))
    }

    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    fn edit(&self, f: impl FnOnce(&mut yrs::TransactionMut<'_>)) -> Vec<u8> {
        let before: StateVector = self.doc.transact().state_vector();
        f(&mut self.doc.transact_mut());
        self.doc.transact().encode_diff_v1(&before)
    }
}

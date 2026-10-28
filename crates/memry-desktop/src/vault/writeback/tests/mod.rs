//! The write-back's invariants (module docs), one pass at a time, over a real `data.db`, real
//! files and the real converter. Every way a body changes is a trigger here: an edit made in
//! the app ([`Fixture::edit_in_app`]) and a body merged from sync ([`Fixture::edit_from_sync`]);
//! and every way a file changes: an outside edit, and the app's own write.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{BODY_FRAGMENT, DocumentRegistry, update_log};
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::markdown::frontmatter::{parse_markdown_note, split_frontmatter_block};
use memry_core::markdown::shared::writing_tools::writing_of_yaml;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::OpenOptions;
use tokio::sync::broadcast;

use super::{Keep, Outcome, Pass};
use crate::vault::consumer::converter_for;
use crate::vault::consumer::rows::{RowOwner, RowStat};
use crate::vault::consumer::tests::with_device_key;
use crate::vault::consumer::{Applied, ChangeSource};
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::watch::EchoGuard;

pub(super) struct Fixture {
    pub(super) _dir: tempfile::TempDir,
    pub(super) root: PathBuf,
    pub(super) vault: Arc<Vault>,
    pub(super) store: Arc<dyn SecureStore>,
    pub(super) rows: Arc<RowOwner>,
    pub(super) echo: Arc<EchoGuard>,
    pub(super) writer: Arc<NotesWriter>,
    pub(super) pass: Pass,
    pub(super) facts: broadcast::Receiver<Applied>,
    server_seq: AtomicI64,
}

pub(super) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let core = root.join(".memry/core");
    std::fs::create_dir_all(&core).unwrap();
    let store = with_device_key();
    let vault = Arc::new(
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap(),
    );
    let rows = RowOwner::new();
    rows.open(vault.clone()).unwrap();
    let echo: Arc<EchoGuard> = Arc::default();
    let pass = Pass::new(
        root.clone(),
        vault.clone(),
        rows.clone(),
        rows.session_for(&vault).unwrap(),
        echo.clone(),
        vault.app_settings(store.clone()).ok(),
    );
    Fixture {
        writer: vault.notes_writer(store.clone()).unwrap(),
        facts: rows.subscribe(),
        _dir: dir,
        root,
        vault,
        store,
        rows,
        echo,
        pass,
        server_seq: AtomicI64::new(1),
    }
}

impl Fixture {
    pub(super) fn write(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    pub(super) fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root.join(rel)).unwrap()
    }

    pub(super) fn run(&self, id: &str) -> Outcome {
        self.pass.run(id)
    }

    /// A note whose file is `text` and whose document took it whole: what the consumer leaves
    /// for a file it fed (`Fed` or `Unchanged`, the row with the file's hash).
    pub(super) fn adopt(&mut self, rel: &str, text: &str) -> String {
        self.write(rel, text);
        let id = self.writer.create("Note".into(), None).unwrap();
        let parsed = parse_markdown_note(text).unwrap();
        let split = split_frontmatter_block(text);
        let input = FeedInput {
            note_id: &id,
            markdown: split.body,
            note_path: Some(rel),
            writing: Some(writing_of_yaml(&parsed.frontmatter)),
            frontmatter: split.block,
        };
        let outcome = self
            .vault
            .external_feed(self.store.clone())
            .unwrap()
            .seed_body_if_empty(&converter_for(None), input)
            .unwrap();
        assert_eq!(outcome, FeedOutcome::Fed);
        self.record(&id, rel, Some(content_hash(text)));
        self.facts();
        id
    }

    /// The row the consumer or the app records for the note's file.
    pub(super) fn record(&self, id: &str, rel: &str, hash: Option<String>) {
        self.record_as(id, rel, FileType::Markdown, hash);
    }

    pub(super) fn record_as(&self, id: &str, rel: &str, file_type: FileType, hash: Option<String>) {
        let size = std::fs::metadata(self.root.join(rel)).map_or(0, |m| m.len());
        let stat = RowStat {
            file_type,
            size,
            content_hash: hash,
        };
        let session = self.rows.session_for(&self.vault).unwrap();
        self.rows.record_write(session, id, rel, stat).unwrap();
    }

    pub(super) fn hash_of(&self, rel: &str) -> Option<String> {
        self.vault
            .note_files()
            .by_path(rel)
            .unwrap()
            .expect("a row")
            .content_hash
    }

    pub(super) fn facts(&mut self) -> Vec<Applied> {
        std::iter::from_fn(|| self.facts.try_recv().ok()).collect()
    }

    /// The first block of the note, retyped in the app's editor.
    pub(super) fn edit_in_app(&self, id: &str, text: &str) {
        let blocks = self.vault.notes().blocks(id.to_owned()).unwrap().unwrap();
        let block_id = blocks
            .iter()
            .find_map(|block| block.id.clone())
            .expect("a block with an id");
        let edit = BlockEdit::SetText {
            block_id,
            text: text.to_owned(),
        };
        assert!(self.writer.edit_block(id.to_owned(), edit).unwrap());
    }

    /// Another device's edit of the note, on top of the body this device holds, stored as the
    /// server sent it.
    pub(super) fn edit_from_sync(&self, id: &str, extend: impl FnOnce(&mut yrs::TransactionMut)) {
        let authored: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::default();
        let sink: UpdateSink = {
            let authored = authored.clone();
            Arc::new(move |_, bytes: &[u8]| authored.lock().unwrap().push(bytes.to_vec()))
        };
        let peer = DocumentRegistry::new("peer-device", sink)
            .get_or_open(id)
            .unwrap();
        let doc_id = id.to_owned();
        let db = self.vault.db_handle();
        let blobs = db
            .call_blocking(move |conn| Ok(update_log::load_plan(conn, &doc_id).unwrap()))
            .unwrap();
        for blob in blobs.blobs() {
            peer.apply_durable_update(blob).unwrap();
        }
        peer.write(|txn| extend(txn)).unwrap();
        let updates = authored.lock().unwrap().clone();
        let doc_id = id.to_owned();
        let first = self
            .server_seq
            .fetch_add(updates.len() as i64, Ordering::SeqCst);
        db.call_blocking(move |conn| {
            for (at, update) in updates.iter().enumerate() {
                update_log::append_server_update(conn, &doc_id, first + at as i64, update, 1)
                    .unwrap();
            }
            Ok(())
        })
        .unwrap();
    }

    /// A paragraph another device appended.
    pub(super) fn paragraph_from_sync(&self, id: &str, text: &str) {
        self.edit_from_sync(id, |txn| raw_block(txn, "paragraph", text));
    }

    pub(super) fn sql(&self, sql: &'static str, id: &str) {
        let id = id.to_owned();
        self.vault
            .db_handle()
            .call_blocking(move |conn| {
                conn.execute(sql, [id]).unwrap();
                Ok(())
            })
            .unwrap();
    }

    pub(super) fn exec(&self, sql: &'static str) {
        self.vault
            .db_handle()
            .call_blocking(move |conn| {
                conn.execute_batch(sql).unwrap();
                Ok(())
            })
            .unwrap();
    }

    /// The note's file is ahead of its document (`owed_file_body`).
    pub(super) fn owe_file(&self, id: &str) {
        self.sql(
            "INSERT INTO meta (key, value) VALUES ('vault.owed_file_body:' || ?1, '0')",
            id,
        );
    }

    /// The note's server body has not been pulled (`sync::body_debt`).
    pub(super) fn owe_server_body(&self, id: &str) {
        self.sql(
            "INSERT INTO meta (key, value) VALUES ('sync.body_owed:' || ?1, '0:0')",
            id,
        );
    }

    /// The versions kept for the note, oldest first.
    pub(super) fn versions(&self, id: &str) -> Vec<String> {
        let id = id.to_owned();
        self.vault
            .db_handle()
            .call_blocking(move |conn| {
                let mut statement = conn
                    .prepare(
                        "SELECT content FROM note_snapshots WHERE note_id = ?1
                         ORDER BY created_at, rowid",
                    )
                    .unwrap();
                Ok(statement
                    .query_map([id], |row| row.get(0))
                    .unwrap()
                    .collect::<Result<Vec<String>, _>>()
                    .unwrap())
            })
            .unwrap()
    }
}

/// Appends `blockContainer > <tag> > text` to the body's block group.
pub(super) fn raw_block(txn: &mut yrs::TransactionMut, tag: &str, text: &str) {
    use yrs::{XmlElementPrelim, XmlFragment as _, XmlOut, XmlTextPrelim};
    let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
    let Some(XmlOut::Element(group)) = fragment.get(txn, 0) else {
        panic!("a seeded body starts with its block group");
    };
    let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
    let block = container.push_back(txn, XmlElementPrelim::empty(tag));
    block.push_back(txn, XmlTextPrelim::new(text));
}

/// Appends a paragraph whose text carries `mark`.
pub(super) fn raw_marked(txn: &mut yrs::TransactionMut, text: &str, mark: &str) {
    use yrs::{Text as _, XmlElementPrelim, XmlFragment as _, XmlOut, XmlTextPrelim};
    let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
    let Some(XmlOut::Element(group)) = fragment.get(txn, 0) else {
        panic!("a seeded body starts with its block group");
    };
    let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
    let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
    let run = paragraph.push_back(txn, XmlTextPrelim::new(""));
    let formats: yrs::types::Attrs = [(Arc::from(mark), yrs::Any::Bool(true))].into();
    run.insert_with_attributes(txn, 0, text, formats);
}

/// The pass wrote: the file holds the new bytes, the row their hash, the own-write record
/// expects them, and the fact went out as the app's.
pub(super) fn assert_wrote(f: &mut Fixture, outcome: &Outcome, rel: &str) -> String {
    let Outcome::Wrote { hash, .. } = outcome else {
        panic!("no write: {outcome:?}");
    };
    let on_disk = f.read(rel);
    assert_eq!(&content_hash(&on_disk), hash);
    assert_eq!(f.hash_of(rel).as_ref(), Some(hash));
    assert_eq!(f.echo.expected_hash(rel).as_ref(), Some(hash));
    let facts = f.facts();
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Changed { path, content_hash: Some(h), source: ChangeSource::App, .. }
                if path == rel && h == hash
        )),
        "{facts:?}"
    );
    on_disk
}

/// The pass kept the file: same bytes, same row, no fact.
pub(super) fn assert_kept(f: &mut Fixture, outcome: &Outcome, keep: Keep, rel: &str, bytes: &str) {
    assert_eq!(outcome, &Outcome::Kept(keep));
    assert_eq!(f.read(rel), bytes);
    assert!(f.facts().is_empty());
}

mod guards;
mod triggers;

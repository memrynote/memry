//! `NotesWriter::promote_mention_tokens` and `Journal::promote_day_mention_tokens`
//! end to end (chapter 12 §12.1.1.1): a body an older desktop seeded with
//! `((date:…))` and `((mention:…))` as text gets its nodes in one stored,
//! queued update, and opening it again writes nothing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{SecureStoreError, StorageError};
use memry_core::api::vault::Vault;
use memry_core::crdt::blocks::Block;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::open_data;
use rusqlite::Connection;

static SCRATCH: AtomicU64 = AtomicU64::new(0);
const TODAY: &str = "2099-06-15";
/// `{anchorId:"dm_1", dateISO:"2026-08-14T09:00:00.000Z", hasTime:false, …}`.
const DATE: &str = "((date:eyJhbmNob3JJZCI6ImRtXzEiLCJkYXRlSVNPIjoiMjAyNi0wOC0xNFQwOTowMDowMC4wMDBaIiwiaGFzVGltZSI6ZmFsc2UsImRhdGVGb3JtYXQiOiJyZWxhdGl2ZSIsInJlbWluZCI6Im5vbmUiLCJ0aW1lRm9ybWF0Ijoic3lzdGVtIn0))";
const LINK: &str = "((mention:https%3A%2F%2Fwww.example.com%2Fx))";

struct MemoryStore(Mutex<HashMap<String, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self
            .0
            .lock()
            .expect("lock")
            .get(&format!("{key:?}"))
            .cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0
            .lock()
            .expect("lock")
            .insert(format!("{key:?}"), value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().expect("lock").remove(&format!("{key:?}"));
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().expect("lock").clear();
        Ok(())
    }
}

fn registered() -> Arc<dyn SecureStore> {
    let mut secret = vec![7u8; 32];
    secret.extend_from_slice(&[9u8; 32]);
    Arc::new(MemoryStore(Mutex::new(HashMap::from([(
        format!("{:?}", SecureStoreKey::DeviceSigningKey),
        secret,
    )]))))
}

fn open(label: &str) -> (PathBuf, Vault) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-mention-tokens-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (dir, vault)
}

/// Rows in the update log and the outbox, read through a second connection.
fn written(dir: &std::path::Path) -> (i64, i64) {
    open_data(&dir.join("data.db"))
        .expect("second open")
        .call_blocking(|conn: &mut Connection| {
            let count = |sql: &str| {
                conn.query_row(sql, [], |row| row.get::<_, i64>(0))
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })
            };
            Ok((
                count("SELECT COUNT(*) FROM yjs_updates")?,
                count("SELECT COUNT(*) FROM outbox")?,
            ))
        })
        .expect("count")
}

/// A paragraph holding the tokens as text, as an older desktop's seed or any
/// edit path that does not promote leaves them.
fn legacy_paragraph(id: &str) -> BlockEdit {
    BlockEdit::InsertParagraph {
        after_block_id: None,
        text: format!("due {DATE} see {LINK} end"),
        new_block_id: id.to_owned(),
    }
}

/// Each run's mark names, or its text when it has none.
fn shape(blocks: &[Block]) -> Vec<String> {
    blocks
        .iter()
        .flat_map(|block| &block.inline)
        .map(|run| {
            run.marks
                .first()
                .cloned()
                .unwrap_or_else(|| run.text.clone())
        })
        .collect()
}

const PROMOTED: [&str; 5] = ["due ", "dateMention", " see ", "linkMention", " end"];

#[test]
fn a_notes_legacy_tokens_are_promoted_once() {
    let (dir, vault) = open("note");
    let writer = vault.notes_writer(registered()).expect("writer");
    let id = writer.create("Legacy".to_owned(), None).expect("create");
    assert!(
        writer
            .edit_block(id.clone(), legacy_paragraph("b1"))
            .expect("edit")
    );
    let before = written(&dir);

    assert!(writer.promote_mention_tokens(id.clone()).expect("promote"));
    let after = written(&dir);
    assert_eq!((after.0 - before.0, after.1 - before.1), (1, 1));
    let blocks = vault
        .notes()
        .blocks(id.clone())
        .expect("read")
        .expect("note");
    assert_eq!(shape(&blocks), PROMOTED);
    let date = &blocks[0].inline[1];
    assert_eq!(
        date.mark_attrs
            .get("dateMention.anchorId")
            .map(String::as_str),
        Some("dm_1")
    );
    let link = &blocks[0].inline[3];
    assert_eq!(
        link.mark_attrs
            .get("linkMention.domain")
            .map(String::as_str),
        Some("example.com")
    );

    // Opening it again finds nothing to promote and writes nothing.
    assert!(!writer.promote_mention_tokens(id).expect("promote"));
    assert_eq!(written(&dir), after);
    assert!(
        !writer
            .promote_mention_tokens("missing".to_owned())
            .expect("promote")
    );
}

#[test]
fn a_journal_days_legacy_tokens_are_promoted_by_date() {
    let (dir, vault) = open("journal");
    let journal = vault.journal(registered()).expect("journal");
    assert!(
        !journal
            .promote_day_mention_tokens(TODAY.to_owned())
            .expect("promote")
    );
    assert_eq!(
        journal.day(TODAY.into()).expect("day"),
        None,
        "promoting created the day"
    );

    let edit = journal
        .edit_day(TODAY.into(), legacy_paragraph("b1"))
        .expect("edit");
    let before = written(&dir);
    assert!(
        journal
            .promote_day_mention_tokens(TODAY.to_owned())
            .expect("promote")
    );
    let after = written(&dir);
    assert_eq!((after.0 - before.0, after.1 - before.1), (1, 1));
    let blocks = vault
        .notes()
        .blocks(edit.id)
        .expect("read")
        .unwrap_or_default();
    assert_eq!(shape(&blocks), PROMOTED);

    assert!(
        !journal
            .promote_day_mention_tokens(TODAY.to_owned())
            .expect("promote")
    );
    assert_eq!(written(&dir), after);
}

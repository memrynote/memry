//! `StickyStore`, desktop's sticky drafts (`stickies/drafts.ts`) over a real vault.
//!
//! The record rules (five schema keys, merge, the id-gone rule, the unknown kind) are pinned in
//! `domain/sticky_draft/tests.rs`; this pins what the accessor adds: the content limit, the ISO
//! instants and the no-op save leaving no outbox row behind.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{SecureStoreError, StorageError};
use memry_core::api::sticky_store::MAX_CONTENT_UNITS;
use memry_core::api::vault::Vault;
use memry_core::domain::sticky_draft::StickyKind;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::open_data;
use rusqlite::Connection;

struct MemoryStore(Mutex<HashMap<String, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().expect("lock").get(&format!("{key:?}")).cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().expect("lock").insert(format!("{key:?}"), value);
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

fn vault() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().expect("the scratch directory");
    let opened = Vault::open("vault-1".to_string(), dir.path().display().to_string()).expect("open");
    (dir, opened)
}

fn outbox_rows(dir: &Path) -> i64 {
    open_data(&dir.join("data.db"))
        .expect("second open")
        .call_blocking(|conn: &mut Connection| {
            conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("the count")
}

fn is_iso_millis(text: &str) -> bool {
    // 2026-10-24T09:30:12.345Z
    text.len() == 24 && text.ends_with('Z') && text.as_bytes()[19] == b'.'
}

#[test]
fn a_draft_saves_updates_lists_and_deletes_with_iso_instants() {
    let (dir, vault) = vault();
    let store = vault.sticky_store(registered()).expect("store");

    let created = store
        .save(None, "Buy oat milk".into(), StickyKind::Note)
        .expect("create");
    assert_eq!(created.kind, "note");
    assert!(is_iso_millis(&created.created_at), "{}", created.created_at);
    assert!(is_iso_millis(&created.modified_at), "{}", created.modified_at);

    let queued = outbox_rows(dir.path());
    let unchanged = store
        .save(Some(created.id.clone()), "Buy oat milk".into(), StickyKind::Note)
        .expect("no-op save");
    assert_eq!(unchanged, created);
    assert_eq!(outbox_rows(dir.path()), queued, "an unchanged save queues nothing");

    let edited = store
        .save(Some(created.id.clone()), "Buy oat milk\nand bread".into(), StickyKind::Task)
        .expect("update");
    assert_eq!(edited.id, created.id);
    assert_eq!(edited.kind, "task");
    assert_eq!(store.list().expect("list"), vec![edited.clone()]);

    assert!(store.delete(created.id.clone()).expect("delete"));
    assert!(!store.delete(created.id).expect("second delete"));
    assert!(store.list().expect("list").is_empty());
}

#[test]
fn content_over_the_limit_is_refused_and_writes_nothing() {
    let (_dir, vault) = vault();
    let store = vault.sticky_store(registered()).expect("store");

    let at_limit = "a".repeat(MAX_CONTENT_UNITS);
    store
        .save(None, at_limit, StickyKind::Note)
        .expect("the limit itself is fine");
    let over = "a".repeat(MAX_CONTENT_UNITS + 1);
    let refused = store.save(None, over, StickyKind::Note);
    assert!(matches!(refused, Err(StorageError::Invalid { .. })), "{refused:?}");
    assert_eq!(store.list().expect("list").len(), 1);
}

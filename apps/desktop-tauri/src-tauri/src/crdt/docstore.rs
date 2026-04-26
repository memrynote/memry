//! In-memory store of open Y.Docs keyed by note id.
//!
//! The outer map lock is held only while inserting, looking up, or removing
//! documents. Yrs transactions run on cloned handles after the map lock drops.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use yrs::{Doc, Transact, Transaction, TransactionMut};

pub type NoteId = String;

#[derive(Clone)]
pub struct DocHandle {
    doc: Arc<Doc>,
}

impl DocHandle {
    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    pub fn with_read<R, F>(&self, f: F) -> R
    where
        F: FnOnce(&Transaction<'_>) -> R,
    {
        let txn = self.doc.transact();
        f(&txn)
    }

    pub fn with_write<R, F>(&self, f: F) -> R
    where
        F: FnOnce(&mut TransactionMut<'_>) -> R,
    {
        let mut txn = self.doc.transact_mut();
        f(&mut txn)
    }

    pub fn with_write_origin<R, F>(&self, origin: u32, f: F) -> R
    where
        F: FnOnce(&mut TransactionMut<'_>) -> R,
    {
        let mut txn = self.doc.transact_mut_with(origin);
        f(&mut txn)
    }
}

pub struct DocStore {
    docs: Mutex<HashMap<NoteId, Arc<Doc>>>,
}

impl DocStore {
    pub fn new() -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
        }
    }

    pub async fn open_count(&self) -> usize {
        self.docs.lock().await.len()
    }

    pub async fn get_or_init(&self, id: &str) -> DocHandle {
        let mut docs = self.docs.lock().await;
        let doc = docs
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Doc::new()))
            .clone();
        DocHandle { doc }
    }

    pub async fn get(&self, id: &str) -> Option<DocHandle> {
        let docs = self.docs.lock().await;
        docs.get(id).cloned().map(|doc| DocHandle { doc })
    }

    pub async fn drop_doc(&self, id: &str) {
        let mut docs = self.docs.lock().await;
        docs.remove(id);
    }

    pub async fn list_open(&self) -> Vec<NoteId> {
        let docs = self.docs.lock().await;
        docs.keys().cloned().collect()
    }
}

impl Default for DocStore {
    fn default() -> Self {
        Self::new()
    }
}

//! CRDT runtime — yrs-backed authoritative Y.Docs keyed by note id.

pub mod apply;
mod docstore;

pub use apply::apply_update_v1;
pub use docstore::{DocHandle, DocStore, NoteId};

use once_cell::sync::Lazy;
use std::sync::Arc;

/// Per-process origin tag. Used to stamp `crdt-update` events so the renderer
/// can drop echoes from its own writes.
static ORIGIN_TAG: Lazy<u32> = Lazy::new(|| {
    std::env::var("MEMRY_ORIGIN_TAG")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value != 0)
        .unwrap_or_else(|| {
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.subsec_nanos())
                .unwrap_or(0);
            pid.wrapping_mul(1_000_003).wrapping_add(nanos) | 1
        })
});

pub fn origin_tag() -> u32 {
    *ORIGIN_TAG
}

pub struct CrdtRuntime {
    docs: DocStore,
}

impl CrdtRuntime {
    pub fn new() -> Self {
        Self {
            docs: DocStore::new(),
        }
    }

    pub fn docs(&self) -> &DocStore {
        &self.docs
    }

    pub async fn open_doc_count(&self) -> usize {
        self.docs.open_count().await
    }
}

impl Default for CrdtRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedCrdt = Arc<CrdtRuntime>;

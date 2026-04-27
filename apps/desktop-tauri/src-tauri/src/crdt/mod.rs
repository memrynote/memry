//! CRDT runtime — yrs-backed authoritative Y.Docs keyed by note id.

pub mod apply;
pub mod compaction;
mod docstore;
pub mod md_to_yjs;
pub mod snapshot;
pub mod state_vector;
pub mod wire;

pub use apply::apply_update_v1;
pub use compaction::{compact_doc, CompactionResult, COMPACT_THRESHOLD};
pub use docstore::{DocHandle, DocStore, NoteId};
pub use snapshot::{encode_diff_since_v1, encode_snapshot_v1};
pub use state_vector::encode_state_vector_v1;

use crate::error::{AppError, AppResult};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

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
    chunks: Mutex<HashMap<String, ChunkedUpdate>>,
}

struct ChunkedUpdate {
    note_id: String,
    total_bytes: usize,
    bytes: Vec<u8>,
}

impl CrdtRuntime {
    pub fn new() -> Self {
        Self {
            docs: DocStore::new(),
            chunks: Mutex::new(HashMap::new()),
        }
    }

    pub fn docs(&self) -> &DocStore {
        &self.docs
    }

    pub async fn open_doc_count(&self) -> usize {
        self.docs.open_count().await
    }

    pub async fn start_update_chunk(
        &self,
        note_id: &str,
        transfer_id: &str,
        total_bytes: usize,
    ) -> AppResult<()> {
        if transfer_id.trim().is_empty() {
            return Err(AppError::Validation("transfer_id is empty".into()));
        }

        let mut chunks = self.chunks.lock().await;
        chunks.insert(
            transfer_id.to_string(),
            ChunkedUpdate {
                note_id: note_id.to_string(),
                total_bytes,
                bytes: Vec::with_capacity(total_bytes),
            },
        );
        Ok(())
    }

    pub async fn append_update_chunk(
        &self,
        transfer_id: &str,
        offset: usize,
        bytes: Vec<u8>,
    ) -> AppResult<()> {
        let mut chunks = self.chunks.lock().await;
        let chunk = chunks
            .get_mut(transfer_id)
            .ok_or_else(|| AppError::NotFound(format!("crdt transfer {transfer_id}")))?;
        if offset != chunk.bytes.len() {
            let expected = chunk.bytes.len();
            chunks.remove(transfer_id);
            return Err(AppError::Validation(format!(
                "chunk offset {offset} does not match expected {}",
                expected
            )));
        }
        let total_bytes = chunk.total_bytes;
        if chunk.bytes.len() + bytes.len() > total_bytes {
            chunks.remove(transfer_id);
            return Err(AppError::Validation(format!(
                "chunk transfer {transfer_id} exceeds declared size {}",
                total_bytes
            )));
        }
        chunk.bytes.extend(bytes);
        Ok(())
    }

    pub async fn finish_update_chunk(
        &self,
        note_id: &str,
        transfer_id: &str,
    ) -> AppResult<Vec<u8>> {
        let mut chunks = self.chunks.lock().await;
        let chunk = chunks
            .remove(transfer_id)
            .ok_or_else(|| AppError::NotFound(format!("crdt transfer {transfer_id}")))?;
        if chunk.note_id != note_id {
            return Err(AppError::Validation(format!(
                "chunk transfer {transfer_id} belongs to note {}",
                chunk.note_id
            )));
        }
        if chunk.bytes.len() != chunk.total_bytes {
            return Err(AppError::Validation(format!(
                "chunk transfer {transfer_id} received {} of {} bytes",
                chunk.bytes.len(),
                chunk.total_bytes
            )));
        }
        Ok(chunk.bytes)
    }
}

impl Default for CrdtRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedCrdt = Arc<CrdtRuntime>;

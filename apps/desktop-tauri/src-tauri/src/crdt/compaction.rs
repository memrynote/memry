//! Snapshot compaction helpers.

use crate::crdt::{encode_snapshot_v1, DocHandle};
use crate::error::AppResult;

pub const COMPACT_THRESHOLD: i64 = 100;

pub struct CompactionResult {
    pub snapshot_bytes: Vec<u8>,
    pub replaced_through_seq: i64,
}

pub fn compact_doc(handle: &DocHandle, max_seq: i64) -> AppResult<CompactionResult> {
    let snapshot_bytes = encode_snapshot_v1(handle)?;
    Ok(CompactionResult {
        snapshot_bytes,
        replaced_through_seq: max_seq,
    })
}

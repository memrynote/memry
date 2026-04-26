//! Decode and apply v1-encoded Yjs updates to authoritative Rust Y.Docs.

use crate::crdt::DocHandle;
use crate::error::{AppError, AppResult};
use yrs::updates::decoder::Decode;
use yrs::Update;

pub fn apply_update_v1(handle: &DocHandle, bytes: &[u8], origin: u32) -> AppResult<()> {
    let update = Update::decode_v1(bytes).map_err(AppError::from)?;
    handle.with_write_origin(origin, |txn| {
        txn.apply_update(update).map_err(AppError::from)
    })?;
    Ok(())
}

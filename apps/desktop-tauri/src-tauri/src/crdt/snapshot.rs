use crate::crdt::DocHandle;
use crate::error::{AppError, AppResult};
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector};

pub fn encode_snapshot_v1(handle: &DocHandle) -> AppResult<Vec<u8>> {
    let bytes = handle.with_read(|txn| txn.encode_state_as_update_v1(&StateVector::default()));
    Ok(bytes)
}

pub fn encode_diff_since_v1(handle: &DocHandle, state_vector: &[u8]) -> AppResult<Vec<u8>> {
    let state_vector = StateVector::decode_v1(state_vector).map_err(AppError::from)?;
    let bytes = handle.with_read(|txn| txn.encode_state_as_update_v1(&state_vector));
    Ok(bytes)
}

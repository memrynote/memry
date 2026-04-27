use crate::crdt::DocHandle;
use crate::error::AppResult;
use yrs::updates::encoder::Encode;
use yrs::ReadTxn;

pub fn encode_state_vector_v1(handle: &DocHandle) -> AppResult<Vec<u8>> {
    let bytes = handle.with_read(|txn| txn.state_vector().encode_v1());
    Ok(bytes)
}

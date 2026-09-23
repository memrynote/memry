//! The conformance seam: reading a document straight from update bytes.
//!
//! **Why this is on the exported surface.** The `note-blocks` class holds
//! three ports to one reading of one document. TypeScript and Rust can both
//! be driven from a committed file directly, but a Swift shell reaches the
//! block walk only through `Notes.blocks`, which needs an opened vault, a
//! database and a note record. A harness that stood all that up to check a
//! walk would be testing the vault; a harness that skipped iOS entirely would
//! leave the shell that actually renders notes as the one port nothing
//! measures.
//!
//! `specs/002-native-foundation-ios/contracts/core-api.md` is explicit that a
//! class is absent from the on-device harness "only because the exported
//! surface cannot reach it, never because it was inconvenient". This is that
//! surface.
//!
//! **These are reads and nothing else.** No database, no network, no vault, no
//! outbox. The bytes go into a throwaway document that is dropped when the
//! call returns, which is also why they are safe to call from a test target
//! with no account.

use crate::crdt::blocks::{Block, TableContent, extract_blocks, extract_table};
use crate::crdt::canonical::canonical_fragment;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use std::sync::Arc;

/// The device id a conformance document is opened under.
///
/// Fixed and obviously not a real device: nothing here writes, so the id only
/// has to be stable enough that two calls behave alike.
const CONFORMANCE_DEVICE: &str = "device-conformance";

/// A throwaway document holding `update`.
///
/// Through the registry, which chapter 12 §12.5.1 makes the only door: a
/// reader that could hold a raw `Doc` could be tempted to rebuild one through
/// named accessors and drop every root this specification does not name.
fn document_of(update: &[u8]) -> Result<Arc<Document>, CrdtError> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(CONFORMANCE_DEVICE, sink).get_or_open("conformance")?;
    document.apply_durable_update(update)?;
    Ok(document)
}

/// One document's body as blocks, from a raw update.
///
/// The same walk `Notes.blocks` runs, on the same code path, without a vault.
#[uniffi::export]
pub fn blocks_from_update(update: Vec<u8>) -> Result<Vec<Block>, CrdtError> {
    let document = document_of(&update)?;
    extract_blocks(&document)
}

/// One table's structure, from a raw update.
#[uniffi::export]
pub fn table_from_update(
    update: Vec<u8>,
    block_id: String,
) -> Result<Option<TableContent>, CrdtError> {
    let document = document_of(&update)?;
    extract_table(&document, &block_id)
}

/// The canonical fragment rendering, from a raw update.
///
/// This is the form the write-direction class compares documents through,
/// because Yjs update bytes cannot be compared across ports — an update
/// encodes `clientID` and per-client clocks, so two ports performing the same
/// edit legitimately differ. `specs/003-ios-note-parity/research.md` records
/// the argument in full.
#[uniffi::export]
pub fn canonical_fragment_from_update(update: Vec<u8>) -> Result<String, CrdtError> {
    let document = document_of(&update)?;
    canonical_fragment(&document)
}

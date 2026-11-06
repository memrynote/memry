//! The text of a note's body as its log held it at another point: at the row's mark
//! ([`crate::domain::note_files::stamped_mark`]), or with an update the editor did not store.

use std::collections::HashSet;
use std::sync::Arc;

use rusqlite::Connection;
use yrs::branch::{Branch, BranchID};
use yrs::{ID, ReadTxn, XmlFragment as _, XmlOut};

use super::LogMark;
use crate::crdt::BODY_FRAGMENT;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use crate::crdt::update_log::{self, LoadPlan};
use crate::domain::note_files;
use crate::markdown::convert::api::Converter;

const READER: &str = "memry-core-stamp-reader";

/// Whether the body's text, as markdown, differs from the text it had when the note's row was
/// stamped: the body moved after the stamp and holds a change its file does not. A body that
/// moved without changing its text (a link made a chip of, an edit undone) did not. `true`
/// when the row has no mark of its stamp, or a fold since took the entries before it.
pub fn text_moved_since_stamp(
    conn: &Connection,
    converter: &Converter,
    note_id: &str,
) -> Result<bool, CrdtError> {
    let Some(mark) = note_files::stamped_mark(conn, note_id)? else {
        return Ok(true);
    };
    let plan = update_log::load_plan(conn, note_id)?;
    let Some(then) = before(&plan, mark) else {
        return Ok(true);
    };
    Ok(text(converter, note_id, &then)? != text(converter, note_id, &plan.blobs())?)
}

/// The markdown of the blocks `update` puts at the top of the body over every stored entry: the
/// body a window put back over an outside edit, which the editor refused, without the blocks
/// another writer left beside it.
pub fn text_put_back(
    conn: &Connection,
    converter: &Converter,
    note_id: &str,
    update: &[u8],
) -> Result<String, CrdtError> {
    let plan = update_log::load_plan(conn, note_id)?;
    let document = opened(note_id, &plan.blobs())?;
    let stored = document.read(|txn| top_level(txn).into_iter().collect::<HashSet<_>>())?;
    document.apply_durable_update(update)?;
    document.write(|txn| {
        let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) else {
            return;
        };
        let theirs: Vec<u32> = (0..fragment.len(txn))
            .filter(|index| {
                fragment
                    .get(txn, *index)
                    .and_then(|node| node_id(&node))
                    .is_some_and(|id| stored.contains(&id))
            })
            .collect();
        for index in theirs.into_iter().rev() {
            fragment.remove_range(txn, index, 1);
        }
    })?;
    Ok(markdown(converter, &document))
}

/// The ids of the body's top-level nodes.
fn top_level<T: ReadTxn>(txn: &T) -> Vec<ID> {
    txn.get_xml_fragment(BODY_FRAGMENT)
        .map(|fragment| {
            fragment
                .children(txn)
                .filter_map(|node| node_id(&node))
                .collect()
        })
        .unwrap_or_default()
}

fn node_id(node: &XmlOut) -> Option<ID> {
    let branch: &Branch = match node {
        XmlOut::Element(element) => element.as_ref(),
        XmlOut::Text(text) => text.as_ref(),
        XmlOut::Fragment(fragment) => fragment.as_ref(),
    };
    match branch.id() {
        BranchID::Nested(id) => Some(id),
        BranchID::Root(_) => None,
    }
}

/// The blobs of `plan` stored before `mark`; `None` when a snapshot folded entries at or past it.
fn before(plan: &LoadPlan, mark: LogMark) -> Option<Vec<&[u8]>> {
    let folded = |snapshot: &Option<update_log::SnapshotRow>, at: i64| {
        snapshot.as_ref().is_some_and(|row| row.last_seq >= at)
    };
    if folded(&plan.server_snapshot, mark.server) || folded(&plan.local_snapshot, mark.local) {
        return None;
    }
    let mut blobs: Vec<&[u8]> = Vec::new();
    blobs.extend(
        plan.server_snapshot
            .iter()
            .map(|row| row.snapshot.as_slice()),
    );
    let server = plan
        .server_updates
        .iter()
        .filter(|row| row.seq < mark.server);
    blobs.extend(server.map(|row| row.update_blob.as_slice()));
    blobs.extend(
        plan.local_snapshot
            .iter()
            .map(|row| row.snapshot.as_slice()),
    );
    let local = plan.local_updates.iter().filter(|row| row.seq < mark.local);
    blobs.extend(local.map(|row| row.update_blob.as_slice()));
    Some(blobs)
}

fn text(converter: &Converter, note_id: &str, blobs: &[&[u8]]) -> Result<String, CrdtError> {
    Ok(markdown(converter, &*opened(note_id, blobs)?))
}

fn opened(note_id: &str, blobs: &[&[u8]]) -> Result<Arc<Document>, CrdtError> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER, sink).get_or_open(note_id)?;
    for blob in blobs {
        document.apply_durable_update(blob)?;
    }
    Ok(document)
}

fn markdown(converter: &Converter, document: &Document) -> String {
    converter
        .doc_to_canonical_markdown(document, BODY_FRAGMENT)
        .unwrap_or_default()
}

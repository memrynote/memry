//! Whether the text of a note's body changed since its row was stamped, read from the body log
//! as it stood at the row's mark ([`crate::domain::note_files::stamped_mark`]).

use std::sync::Arc;

use rusqlite::Connection;

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
/// moved without changing its text (a link made a chip of, an edit undone) did not. `None`
/// when the log cannot say: the row has no mark of its stamp (an older build stamped it), or a
/// fold since took the entries before it.
pub fn text_moved_since_stamp(
    conn: &Connection,
    converter: &Converter,
    note_id: &str,
) -> Result<Option<bool>, CrdtError> {
    let Some(mark) = note_files::stamped_mark(conn, note_id)? else {
        return Ok(None);
    };
    let plan = update_log::load_plan(conn, note_id)?;
    let Some(then) = before(&plan, mark) else {
        return Ok(None);
    };
    Ok(Some(
        text(converter, note_id, &then)? != text(converter, note_id, &plan.blobs())?,
    ))
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

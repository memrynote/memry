//! Tags on a `note` or a `journal` record (T127, FR-047).
//!
//! Two rules, and they pull in opposite directions on purpose:
//!
//! - **stored exactly as typed.** The string the user typed is the string that
//!   lands in the payload's `tags` array. Nothing here lowercases, trims or
//!   canonicalises a tag against another note's spelling — that would rewrite
//!   the user's text to make a comparison cheaper.
//! - **deduped by identity.** Two spellings of one tag are one tag.
//!
//! **Identity is the Unicode fold of chapter 13 §13.7.7 ("tag identity"),**
//! pinned by the `tag-fold` vectors and shared with desktop's
//! `packages/shared/src/tag-fold.ts`. Each scalar folds on its own, with no
//! locale and no context: `İ` (U+0130) is `i`, final `ς` is `σ`, a combining
//! dot above (U+0307) right after a character that folded to `i` is dropped,
//! and every other character takes its Unicode lowercase. So `Ünal`/`ünal`,
//! `İş`/`iş`/`i̇ş` and `Café`/`CAFÉ` are one tag each, while `ı` and `i` stay two.
//!
//! SQLite's `COLLATE NOCASE` folds `A`–`Z` only, so SQL that matches or groups
//! tags must not rely on it: readers select the rows and fold here. The fold
//! can change a string's length, so never cut an original spelling at a folded
//! string's length; split on `/` instead.
//!
//! ## Why the edits live here and not in the projector
//!
//! `note_tags` is a cache of a parse (data-model §A.1). A tag edit therefore
//! rewrites the **payload** — by merging into the parsed copy, chapter 13 §13.2
//! rule 3 — and the projection follows from that. The merge and the outbox row
//! that publishes it commit in one transaction (FR-030, data-model §A.2).
//!
//! ## What this module does not touch
//!
//! The document's `tags` root. Chapter 12 §12.5.2 leaves the two-writer case —
//! the Y.Doc root and the record payload disagreeing — **undefined, with no
//! tiebreak**, and says a client MUST NOT construct a case that depends on
//! which wins. The record payload is where §13.7.1 puts `tags`, so that is the
//! only copy this core writes.

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::clock::{self, VectorClock};
use crate::sync::outbox;

/// The two record types that carry `tags` and merge document-level
/// (chapter 13 §13.7.1, §13.7.2, chapter 06 §6.8).
///
/// `task` also carries a `tags` array and is deliberately excluded: it merges
/// field-level over `fieldClocks`, so bumping only the document clock the way
/// [`add`] does would be the wrong write. Tasks are T129's.
pub const TAGGABLE_TYPES: [&str; 2] = ["note", "journal"];

/// The fold two spellings of one tag share (§13.7.7 tag identity). See the
/// module comment. `fold(fold(s)) == fold(s)` and
/// `fold(&s.to_lowercase()) == fold(s)`.
pub fn fold(tag: &str) -> String {
    let mut out = String::with_capacity(tag.len());
    let mut after_i = false;
    for c in tag.chars() {
        if after_i && c == '\u{0307}' {
            continue;
        }
        match c {
            '\u{0130}' => out.push('i'),
            '\u{03C2}' => out.push('\u{03C3}'),
            _ => out.extend(c.to_lowercase()),
        }
        let mut folded = c.to_lowercase();
        after_i = c == '\u{0130}' || (folded.next() == Some('i') && folded.next().is_none());
    }
    out
}

/// A tag's key: the trimmed spelling, folded. `tag_definition` ids and schema
/// references compare by this.
pub fn tag_key(tag: &str) -> String {
    fold(tag.trim())
}

/// Whether two spellings are the same tag.
pub fn same_tag(a: &str, b: &str) -> bool {
    fold(a) == fold(b)
}

/// Collapses case-variant spellings, **keeping the first one seen** and the
/// order it was seen in.
///
/// First-wins rather than last-wins because the earlier entry is the one
/// already on the note: a later duplicate must not silently recase what is
/// there.
pub fn dedupe<I>(tags: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut kept: Vec<String> = Vec::new();
    for tag in tags {
        if !kept.iter().any(|existing| same_tag(existing, &tag)) {
            kept.push(tag);
        }
    }
    kept
}

/// The tags on an item, exactly as the payload spells them.
///
/// An item with no row reads as no tags, which is what it is. An item whose
/// payload will not parse, or whose `tags` is not an array of strings, is a
/// **hard error** and never an empty list: FR-032 states that rule for a
/// zero-row first page and it applies to every reader, because a silent empty
/// here would make the next [`set`] delete every tag on the note.
pub fn list(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Vec<String>, StorageError> {
    let Some(payload) = stored(conn, item_type, item_id)? else {
        return Ok(Vec::new());
    };
    read_tags(payload.object(), "tags", item_type, item_id)
}

/// Adds one tag, as typed.
///
/// A tag already on the item under any casing is not added again and **nothing
/// is written**: no payload rewrite, no clock tick, no outbox row. An edit that
/// changes nothing must not push, or every idle tap would ship a new clock and
/// win a conflict it had no business winning.
pub fn add(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    tag: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let payload = require(conn, item_type, item_id)?;
    let mut tags = read_tags(payload.object(), "tags", item_type, item_id)?;
    if tags.iter().any(|existing| same_tag(existing, tag)) {
        return Ok(tags);
    }
    tags.push(tag.to_owned());
    write(
        conn, item_type, item_id, &payload, tags, None, device_id, now_ms,
    )
}

/// Removes one tag, matched case-insensitively.
///
/// Also drops it from `pinnedTags` — but **only when that key is already
/// present**. Adding a `pinnedTags` key that was absent would turn §13.4's
/// "the sender does not know this field" into an explicit empty list, which is
/// how a real unpin travels, and would clear another device's pins.
pub fn remove(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    tag: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let payload = require(conn, item_type, item_id)?;
    let mut tags = read_tags(payload.object(), "tags", item_type, item_id)?;
    let Some(at) = tags.iter().position(|existing| same_tag(existing, tag)) else {
        return Ok(tags);
    };
    tags.remove(at);
    let pinned = unpin(payload.object(), &tags, item_type, item_id)?;
    write(
        conn, item_type, item_id, &payload, tags, pinned, device_id, now_ms,
    )
}

/// Replaces the whole list, deduped and in the given order.
pub fn set(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    tags: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let payload = require(conn, item_type, item_id)?;
    let current = read_tags(payload.object(), "tags", item_type, item_id)?;
    let next = dedupe(tags.iter().cloned());
    if next == current {
        return Ok(current);
    }
    let pinned = unpin(payload.object(), &next, item_type, item_id)?;
    write(
        conn, item_type, item_id, &payload, next, pinned, device_id, now_ms,
    )
}

/// Keyed payload changes for [`sync_items::apply_local_edit_in`].
pub type PayloadChanges = Vec<(&'static str, Change)>;

/// The payload changes [`set`] would merge for `tags` on `object`: the deduped
/// list and the changes (`tags`, plus `pinnedTags` when a pin drops). The
/// changes are empty when the list is unchanged. Clock, `modifiedAt` and the
/// transaction are the caller's (the journal metadata writes, D2).
pub fn set_changes(
    object: &Object,
    item_type: &str,
    item_id: &str,
    tags: &[String],
) -> Result<(Vec<String>, PayloadChanges), StorageError> {
    let current = read_tags(object, "tags", item_type, item_id)?;
    let next = dedupe(tags.iter().cloned());
    if next == current {
        return Ok((current, Vec::new()));
    }
    let mut changes = vec![("tags", Change::set(next.clone()))];
    if let Some(pinned) = unpin(object, &next, item_type, item_id)? {
        changes.push(("pinnedTags", Change::set(pinned)));
    }
    Ok((next, changes))
}

/// `pinnedTags` minus every entry no longer in `tags`, or `None` when the key
/// is absent or nothing changed.
fn unpin(
    object: &Object,
    tags: &[String],
    item_type: &str,
    item_id: &str,
) -> Result<Option<Vec<String>>, StorageError> {
    if !object.contains_key("pinnedTags") {
        return Ok(None);
    }
    let pinned = read_tags(object, "pinnedTags", item_type, item_id)?;
    let kept: Vec<String> = pinned
        .iter()
        .filter(|pin| tags.iter().any(|tag| same_tag(tag, pin)))
        .cloned()
        .collect();
    Ok((kept != pinned).then_some(kept))
}

/// Merges the new arrays into the payload and publishes the item, in one
/// transaction.
///
/// `clock` is ticked because `note` and `journal` merge document-level
/// (chapter 06 §6.8): an edit that did not tick would lose to any peer's row.
/// `modifiedAt` is emitted in the **string** shape §13.5 requires.
#[allow(clippy::too_many_arguments)]
fn write(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    payload: &StoredPayload,
    tags: Vec<String>,
    pinned: Option<Vec<String>>,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let ticked = clock::increment(
        &document_clock(payload.object(), item_type, item_id)?,
        device_id,
    );
    let modified_at = instants::to_iso8601(now_ms).ok_or_else(|| StorageError::Failed {
        what: format!("{now_ms} is not a representable instant"),
    })?;

    let mut changes = vec![
        ("tags", Change::set(tags.clone())),
        ("clock", Change::set(clock_value(&ticked))),
        ("modifiedAt", Change::set(modified_at)),
    ];
    if let Some(pinned) = pinned {
        changes.push(("pinnedTags", Change::set(pinned)));
    }

    let tx = conn.unchecked_transaction().map_err(failed)?;
    sync_items::apply_local_edit_in(&tx, item_type, item_id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(item_type, item_id), now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(tags)
}

/// The stored payload of a taggable item, or `None` when there is no row yet.
fn stored(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<StoredPayload>, StorageError> {
    if !TAGGABLE_TYPES.contains(&item_type) {
        return Err(StorageError::Failed {
            what: format!("`{item_type}` does not carry document-level tags"),
        });
    }
    let Some(row) = sync_items::load(conn, item_type, item_id)? else {
        return Ok(None);
    };
    let Some(stored) = row.payload else {
        return Ok(None);
    };
    StoredPayload::parse(&stored)
        .map(Some)
        .map_err(|error| StorageError::Failed {
            what: format!("{item_type}/{item_id} payload will not parse: {error}"),
        })
}

/// The stored payload of an item an edit is about to change. Absent is an
/// error here, unlike in [`stored`]: there is nothing to merge into.
fn require(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<StoredPayload, StorageError> {
    stored(conn, item_type, item_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("no {item_type}/{item_id} payload to tag"),
    })
}

/// One of the payload's string arrays, or an error. Never a silent empty.
fn read_tags(
    object: &Object,
    key: &str,
    item_type: &str,
    item_id: &str,
) -> Result<Vec<String>, StorageError> {
    let Some(value) = object.get(key) else {
        return Ok(Vec::new());
    };
    let refuse = || StorageError::Failed {
        what: format!("{item_type}/{item_id}: `{key}` is not an array of strings"),
    };
    value
        .as_array()
        .ok_or_else(refuse)?
        .iter()
        .map(|entry| entry.as_str().map(str::to_owned).ok_or_else(refuse))
        .collect()
}

/// The item's document clock. A clock that will not read as ticks is a hard
/// error rather than an empty clock: an empty one lowers `clockTotal` and
/// changes who wins the next merge (chapter 06 §6.10).
fn document_clock(
    object: &Object,
    item_type: &str,
    item_id: &str,
) -> Result<VectorClock, StorageError> {
    let Some(value) = object.get("clock") else {
        return Ok(VectorClock::new());
    };
    let refuse = || StorageError::Failed {
        what: format!("{item_type}/{item_id}: `clock` is not a vector clock"),
    };
    value
        .as_object()
        .ok_or_else(refuse)?
        .iter()
        .map(|(device, tick)| Ok((device.clone(), tick.as_u64().ok_or_else(refuse)?)))
        .collect()
}

/// A clock as the payload spells it. `BTreeMap` gives code-point key order,
/// which is the canonical form chapter 06 §6.4.2 compares against.
fn clock_value(clock: &VectorClock) -> Value {
    Value::Object(
        clock
            .iter()
            .map(|(device, tick)| (device.clone(), Value::from(*tick)))
            .collect(),
    )
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
#[path = "tags_tests.rs"]
mod tests;

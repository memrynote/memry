//! A tag merged into another or deleted (`tags:merge`, `tags:delete`, `tags:remove-from-note` of
//! desktop `ipc/tags-handlers.ts`): the tag itself, by tag fold, never its `/` children or a
//! body's `#tags`, as Electron's `mergeTagInNotes` and `deleteTag` match it (`tagIs`). A rename,
//! which carries children and bodies along, is [`super::tag_rename`].
//!
//! On desktop a note's file holds its tags too, so its notes and days go one at a time
//! ([`holders_of`], then [`retag`] once the file took the edit) and the rest goes in
//! [`merge_shared`] or [`delete_shared`]: the tasks, the definitions and, for a merge, the
//! schema references. [`super::tag_admin::merge`] and [`super::tag_admin::delete`] do both halves at once, for
//! a device whose notes have no files. Both are idempotent: run again, each finds what the
//! first run left and converges, so neither records a plan as a rename does.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::tag_admin::{
    delete_definitions, item_count, refuse, rewrite_of, upsert_definition,
};
use crate::domain::tag_rename::{Holder, holders_where};
use crate::domain::{body_write, tag_schema_refs, tags};

/// `tags` with `source` replaced by `target`, or dropped with no `target`; a target the list
/// holds already keeps its first spelling and place.
pub fn retagged_list(tags: &[String], source: &str, target: Option<&str>) -> Vec<String> {
    tags::dedupe(
        tags.iter()
            .filter_map(|tag| match tags::same_tag(tag, source) {
                true => target.map(str::to_owned),
                false => Some(tag.clone()),
            }),
    )
}

/// The lists [`retag`] makes of `tags` and `pins`: a pin follows its tag to the target, or
/// goes with it, each in the spelling the list holds it in.
pub fn retagged_lists(
    tags: &[String],
    pins: Option<&[String]>,
    source: &str,
    target: Option<&str>,
) -> (Vec<String>, Option<Vec<String>>) {
    let next = retagged_list(tags, source, target);
    let pins = pins.map(|pins| tags::spelled_in(retagged_list(pins, source, target), &next));
    (next, pins)
}

/// What [`retag`] did to one note or day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retag {
    Wrote,
    /// Neither list changed.
    Unchanged,
    /// The note or day is locked: its tags are kept (Electron `keepLockedNoteTags`,
    /// `writableTagCarrier`), and nothing was written.
    Locked,
}

/// `source` merged into `target` (or deleted, with no `target`) in the `tags` and `pinnedTags`
/// of the live note or journal day `item_id`: one transaction and one outbox row
/// ([`tags::rename_with`]), nothing written when neither list changes or the item is locked.
pub fn retag(
    conn: &Connection,
    item_id: &str,
    source: &str,
    target: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Retag, StorageError> {
    if body_write::is_locked(conn, item_id)? {
        return Ok(Retag::Locked);
    }
    let wrote = tags::rename_with(
        conn,
        item_id,
        |tags, pins| retagged_lists(tags, pins, source, target),
        device_id,
        now_ms,
    )?;
    Ok(if wrote {
        Retag::Wrote
    } else {
        Retag::Unchanged
    })
}

/// The live notes and journal days carrying `tag` itself in their record's tags or, for a
/// note, the header tags the index last read from its file (`headers`): what a merge or a
/// delete of it edits. A body's `#tags` are left, so they do not count.
pub fn holders_of(
    conn: &Connection,
    headers: impl IntoIterator<Item = (String, Vec<String>)>,
    tag: &str,
) -> Result<Vec<Holder>, StorageError> {
    holders_where(conn, headers, Vec::new(), |carried| {
        tags::same_tag(carried, tag)
    })
}

/// The target a merge of `source` takes, trimmed; two names of one tag are refused.
pub fn merge_target<'a>(source: &str, target: &'a str) -> Result<&'a str, StorageError> {
    let target = target.trim();
    if target.is_empty() || tags::same_tag(source.trim(), target) {
        return Err(refuse("merge needs two different tags"));
    }
    Ok(target)
}

/// What a merge of `source` into `target` does besides the notes and days: each task carrying
/// it retagged, its definitions tombstoned, the target's made when missing, and the schema
/// references moved. Returns the number of tasks retagged.
pub fn merge_shared(
    conn: &Connection,
    source: &str,
    target: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
    let target = merge_target(source, target)?;
    let tasks = rewrite_of(conn, &["task"], source, Some(target), device_id, now_ms)?;
    delete_definitions(conn, source, device_id, now_ms)?;
    upsert_definition(conn, target, None, Vec::new(), device_id, now_ms)?;
    tag_schema_refs::rewrite_definitions(conn, source, Some(target), device_id, now_ms)?;
    Ok(item_count(tasks.len()))
}

/// What a delete of `tag` does besides the notes and days: the tag taken off each task, and
/// its definitions tombstoned. Returns the number of tasks retagged.
pub fn delete_shared(
    conn: &Connection,
    tag: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
    let tasks = rewrite_of(conn, &["task"], tag, None, device_id, now_ms)?;
    delete_definitions(conn, tag, device_id, now_ms)?;
    Ok(item_count(tasks.len()))
}

#[cfg(test)]
#[path = "tag_retag_tests.rs"]
mod tests;

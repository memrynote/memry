//! Search filters (#4321): which types, a modified-date range and tags.
//!
//! Desktop narrows a search the same three ways (`applyPostFilters` in
//! `search.ts`) and over-fetches ×5 while a date or tag filter is on, so the
//! limit still fills after the filter drops hits. This keeps both and drops
//! two of desktop's quirks: the filter applies to fuzzy and alias hits too,
//! and a tag no item carries keeps nothing rather than everything.
//!
//! **Tags** match any of the chosen ones by the tag fold (§13.7.7): a note's
//! or journal day's payload and body tags, a task's `tags`, and a capture's
//! device-local `inbox_item_tags`.
//!
//! **Modified** is the record's `modified_at`, and for notes and journal days
//! the later of that and the newest body update this device holds. Desktop
//! pushes a body edit as a CRDT update with no record, so the record stamp
//! alone would leave a note edited today out of "Today". The update stamp is
//! this device's apply time, so a body first pulled today also reads as
//! modified today.

use std::collections::HashSet;

use rusqlite::{Connection, ToSql};

use crate::api::errors::StorageError;
use crate::crdt::update_log::LOCAL_NAMESPACE_PREFIX;
use crate::domain::body_tags::ALL_NOTE_TAGS;

use super::failed;

/// One kind of search result, as the scope picker names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum SearchType {
    Note,
    Journal,
    Task,
    Inbox,
}

impl SearchType {
    pub const ALL: [Self; 4] = [Self::Note, Self::Journal, Self::Task, Self::Inbox];
}

/// Epoch milliseconds, both ends inclusive. The shell computes it from the
/// device's local day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct ModifiedRange {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// What a search is narrowed to. The default narrows nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct SearchFilter {
    /// The types to search; empty searches every type.
    pub types: Vec<SearchType>,
    pub modified: Option<ModifiedRange>,
    /// Items carrying any of these; empty applies no tag filter.
    pub tags: Vec<String>,
}

impl SearchFilter {
    pub(super) fn wants(&self, kind: SearchType) -> bool {
        self.types.is_empty() || self.types.contains(&kind)
    }

    /// Desktop's ×5 while a date or tag filter drops hits after the query.
    pub(super) fn fetch_limit(&self, limit: usize) -> usize {
        if self.narrows() { limit * 5 } else { limit }
    }

    fn narrows(&self) -> bool {
        self.modified.is_some() || !self.tags.is_empty()
    }

    /// The live ids of `kind` the date and tag filters keep, or `None` when
    /// neither is set.
    pub(super) fn kept(
        &self,
        data: &Connection,
        kind: SearchType,
    ) -> Result<Option<HashSet<String>>, StorageError> {
        if !self.narrows() {
            return Ok(None);
        }
        let any_tag = "tag_fold(t.tag) IN (SELECT tag_fold(value) FROM json_each(?1))";
        let (table, tagged, modified) = match kind {
            SearchType::Note | SearchType::Journal => (
                if kind == SearchType::Note { "notes" } else { "journal_entries" },
                format!("EXISTS (SELECT 1 FROM {ALL_NOTE_TAGS} t WHERE t.note_id = x.id AND {any_tag})"),
                "MAX(COALESCE(x.modified_at, x.created_at, 0),
                     COALESCE((SELECT MAX(created_at) FROM yjs_updates
                               WHERE doc_id IN (x.id, ?4 || x.id)), 0),
                     COALESCE((SELECT MAX(compacted_at) FROM yjs_snapshots
                               WHERE doc_id IN (x.id, ?4 || x.id)), 0))",
            ),
            SearchType::Task => (
                "tasks",
                "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(x.tags) THEN x.tags ELSE '[]' END) t
                 WHERE t.type = 'text' AND tag_fold(t.value) IN (SELECT tag_fold(value) FROM json_each(?1)))"
                    .to_owned(),
                "COALESCE(x.modified_at, x.created_at, 0)",
            ),
            SearchType::Inbox => (
                "inbox_items",
                format!("EXISTS (SELECT 1 FROM inbox_item_tags t WHERE t.item_id = x.id AND {any_tag})"),
                "COALESCE(x.modified_at, x.created_at, 0)",
            ),
        };
        let sql = format!(
            "SELECT x.id FROM {table} x WHERE x.deleted_at IS NULL
               AND (?1 IS NULL OR {tagged})
               AND (?2 IS NULL OR {modified} BETWEEN ?2 AND ?3)"
        );
        let tags = (!self.tags.is_empty())
            .then(|| serde_json::to_string(&self.tags))
            .transpose()
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })?;
        let (from, to) = self
            .modified
            .map(|range| (range.from_ms, range.to_ms))
            .unzip();
        let mut parameters: Vec<&dyn ToSql> = vec![&tags, &from, &to];
        if matches!(kind, SearchType::Note | SearchType::Journal) {
            parameters.push(&LOCAL_NAMESPACE_PREFIX);
        }
        let mut statement = data.prepare(&sql).map_err(failed)?;
        let rows = statement
            .query_map(parameters.as_slice(), |row| row.get::<_, String>(0))
            .map_err(failed)?;
        rows.map(|row| row.map_err(failed))
            .collect::<Result<_, _>>()
            .map(Some)
    }
}

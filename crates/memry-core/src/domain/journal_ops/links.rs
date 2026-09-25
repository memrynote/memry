//! Backlinks and outgoing links over notes **and** journal days (N800).
//!
//! Desktop titles a journal with its date (`journal-handler.ts`, `title:
//! entry.date`), so for link matching a day's title is its `YYYY-MM-DD` date:
//! `[[2026-04-16]]` links to that day, and a day that links somewhere is a
//! backlink source named by its date. The `j<date>` id form names the day too
//! ([`note_meta::resolve_wiki_target_kind`]).
//!
//! `note_links` lives in `index.db` and titles live in `data.db`; the two are
//! joined here in Rust because they are separate databases on purpose.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::api::search::BacklinkOrder;
use crate::domain::note_meta;
use crate::domain::notes::failed;

/// One item linking to a note or a journal day.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BacklinkRow {
    pub source_id: String,
    /// The note's title, or the journal's date.
    pub source_title: String,
    /// `note` or `journal`.
    pub source_kind: String,
    /// The journal's date, `None` for a note source.
    pub source_date: Option<String>,
    /// The title the link spells, which can lag a rename of the target.
    pub target_title: String,
    /// Always `false`: nothing projects property-sourced links yet.
    pub via_property: bool,
    /// The source's `modified_at`, else `created_at`, else 0 (epoch ms).
    pub stamp: i64,
}

/// One link a note or journal day makes.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct OutgoingLink {
    /// The title the link spells.
    pub target_title: String,
    /// `None` when the link is broken.
    pub target_id: Option<String>,
    /// `note`, `journal` or `missing`.
    pub target_kind: String,
    /// The journal's date when the target is a day.
    pub target_date: Option<String>,
}

/// What a target or source id names in `data.db`.
enum Item {
    Note { title: String, stamp: i64 },
    Journal { date: String, stamp: i64 },
}

/// Every live note or journal day linking to `target_id`, a note id or a
/// journal record id. Empty when the id names nothing live. A self-link and a
/// tombstoned source are left out.
///
/// A note target matches on `target_id` or its exact title (the existing
/// `Search::backlinks` rule). A day matches on `target_id` or on a title
/// spelling its date (`2026-04-16` or `j2026-04-16`) unless that link was
/// resolved to a live note of the same title, which wins resolution.
pub fn backlinks(
    data: &Connection,
    index: &Connection,
    target_id: &str,
    order: BacklinkOrder,
) -> Result<Vec<BacklinkRow>, StorageError> {
    let Some(target) = live_item(data, target_id)? else {
        return Ok(Vec::new());
    };
    let (title, id_form) = match &target {
        Item::Note { title, .. } => (title.clone(), title.clone()),
        Item::Journal { date, .. } => (date.clone(), format!("j{date}")),
    };

    let mut rows: Vec<(String, Option<String>, String)> = Vec::new();
    let mut statement = index
        .prepare(
            "SELECT source_id, target_id, target_title FROM note_links \
             WHERE target_id = ?1 OR target_title = ?2 OR target_title = ?3",
        )
        .map_err(failed)?;
    let found = statement
        .query_map(params![target_id, &title, &id_form], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(failed)?;
    for row in found {
        rows.push(row.map_err(failed)?);
    }

    let mut out = Vec::new();
    for (source_id, linked_id, target_title) in rows {
        if source_id == target_id {
            continue;
        }
        if matches!(target, Item::Journal { .. })
            && let Some(other) = linked_id.as_deref().filter(|id| *id != target_id)
            && crate::domain::reads::note_exists(data, other)
        {
            continue;
        }
        let Some(source) = live_item(data, &source_id)? else {
            continue;
        };
        let (source_title, source_kind, source_date, stamp) = match source {
            Item::Note { title, stamp } => (title, "note", None, stamp),
            Item::Journal { date, stamp } => (date.clone(), "journal", Some(date), stamp),
        };
        out.push(BacklinkRow {
            source_id,
            source_title,
            source_kind: source_kind.to_owned(),
            source_date,
            target_title,
            via_property: false,
            stamp,
        });
    }
    sort(&mut out, order);
    Ok(out)
}

/// Every link `source_id` (a note or journal day) makes, resolved now against
/// `data.db` rather than the index's stored `target_id`, so a target created
/// or renamed since the last reindex reads correctly. Ordered by the spelled
/// title, case-insensitively. Empty when the source is not live.
pub fn outgoing_links(
    data: &Connection,
    index: &Connection,
    source_id: &str,
) -> Result<Vec<OutgoingLink>, StorageError> {
    if live_item(data, source_id)?.is_none() {
        return Ok(Vec::new());
    }
    let mut statement = index
        .prepare(
            "SELECT target_title FROM note_links WHERE source_id = ?1 \
             ORDER BY target_title COLLATE NOCASE, target_title",
        )
        .map_err(failed)?;
    let titles = statement
        .query_map(params![source_id], |row| row.get::<_, String>(0))
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;

    let mut out = Vec::with_capacity(titles.len());
    for target_title in titles {
        let resolved = note_meta::resolve_wiki_target_kind(data, &target_title)?;
        out.push(match resolved {
            Some(found) => OutgoingLink {
                target_title,
                target_id: Some(found.id),
                target_kind: found.kind,
                target_date: found.date,
            },
            None => OutgoingLink {
                target_title,
                target_id: None,
                target_kind: "missing".to_owned(),
                target_date: None,
            },
        });
    }
    Ok(out)
}

/// A live note, else a live journal day, by id.
fn live_item(data: &Connection, id: &str) -> Result<Option<Item>, StorageError> {
    let note = data
        .query_row(
            "SELECT title, COALESCE(modified_at, created_at, 0) FROM notes \
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(failed)?;
    if let Some((title, stamp)) = note {
        return Ok(Some(Item::Note { title, stamp }));
    }
    let journal = data
        .query_row(
            "SELECT date, COALESCE(modified_at, created_at, 0) FROM journal_entries \
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(failed)?;
    Ok(journal.map(|(date, stamp)| Item::Journal { date, stamp }))
}

/// Desktop's three orders, ties broken by source id.
fn sort(rows: &mut [BacklinkRow], order: BacklinkOrder) {
    match order {
        BacklinkOrder::Recent => rows.sort_by(|a, b| {
            b.stamp
                .cmp(&a.stamp)
                .then_with(|| a.source_id.cmp(&b.source_id))
        }),
        BacklinkOrder::Oldest => rows.sort_by(|a, b| {
            a.stamp
                .cmp(&b.stamp)
                .then_with(|| a.source_id.cmp(&b.source_id))
        }),
        BacklinkOrder::Title => rows.sort_by(|a, b| {
            a.source_title
                .to_lowercase()
                .cmp(&b.source_title.to_lowercase())
                .then_with(|| a.source_id.cmp(&b.source_id))
        }),
    }
}

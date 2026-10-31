//! The link reads of desktop's note surface (#3530 13i): the notes linking to a note, and
//! the note a title or a wiki-link target names, with the path of its file.
//!
//! Desktop's `getNoteLinks` (`notes-queries.ts`) and `resolveLinkTargets`
//! (`wiki-target-resolver.ts`) are the reference. They read the index's `note_links` and
//! the names [`WikiNames`] holds; each answer costs a fixed number of statements whatever
//! the size of the vault or the number of links, so a note with many backlinks opens as
//! fast as one with none.

use std::collections::HashMap;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::journal_ops::links::{id_list, live_items};
use crate::domain::notes::failed;
use crate::domain::wiki_target::{MatchedBy, WikiMatch, WikiNames};

/// One note or journal day whose body links to the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingLink {
    pub source_id: String,
    /// The note's title, or the journal's date.
    pub source_title: String,
    /// `note` or `journal`.
    pub source_kind: String,
    /// The journal's date, `None` for a note source.
    pub source_date: Option<String>,
    /// The vault path of the source's file, `None` when no file row names it (a note or day
    /// whose file the vault tier has not recorded).
    pub source_path: Option<String>,
}

/// The target's name and every link to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Incoming {
    /// The target's title (a day's date), `None` when it is not live.
    pub target_title: Option<String>,
    pub sources: Vec<IncomingLink>,
}

/// Every live note or journal day whose links resolved to `target_id`, once per source,
/// by source title and then id, and the target's own title, read in the same statement.
/// `getIncomingLinks` matches `target_id` only: a link the index resolved to another note of
/// the same name is that note's backlink. A self link and a tombstoned source are left out;
/// so is a second link from the same source, which Electron lists as a second card.
pub fn incoming(
    data: &Connection,
    index: &Connection,
    target_id: &str,
) -> Result<Incoming, StorageError> {
    let mut statement = index
        .prepare("SELECT DISTINCT source_id FROM note_links WHERE target_id = ?1")
        .map_err(failed)?;
    let ids = statement
        .query_map(params![target_id], |row| row.get::<_, String>(0))
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let sources = live_items(data, ids.iter().map(String::as_str).chain([target_id]))?;
    let target_title = sources.get(target_id).map(|target| target.named().0);
    let mut out: Vec<IncomingLink> = ids
        .into_iter()
        .filter(|id| id != target_id)
        .filter_map(|source_id| {
            let source = sources.get(&source_id)?;
            let (source_title, source_kind, source_date) = source.named();
            Some(IncomingLink {
                source_path: source.path.clone(),
                source_id,
                source_title,
                source_kind: source_kind.to_owned(),
                source_date,
            })
        })
        .collect();
    out.sort_by_cached_key(|link| (link.source_title.to_lowercase(), link.source_id.clone()));
    Ok(Incoming {
        target_title,
        sources: out,
    })
}

/// The note or journal day a title or wiki-link target names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTarget {
    pub id: String,
    /// The note's title, or the journal's date.
    pub title: String,
    /// The journal's date, `None` for a note.
    pub journal_date: Option<String>,
    /// The note's folder, `None` at the vault root and for a journal day.
    pub folder_path: Option<String>,
    /// The file row's type when the note has one, else the record's (`markdown` for a day).
    pub file_type: String,
    /// The vault path of the note's or day's file, `None` when no file row names it.
    pub path: Option<String>,
    pub matched_by: MatchedBy,
}

/// What each of `queries` names as a whole (`resolveLinkTargets`: no `#` heading split),
/// in order. One load of the names and one read of the matched notes for the whole batch.
pub fn resolve_titles(
    data: &Connection,
    queries: &[String],
) -> Result<Vec<Option<LinkTarget>>, StorageError> {
    if queries.is_empty() {
        return Ok(Vec::new());
    }
    let names = WikiNames::load_for(data, queries.iter().map(String::as_str))?;
    let found: Vec<Option<WikiMatch>> = queries.iter().map(|query| names.resolve(query)).collect();
    targets(data, found)
}

/// What a wiki-link target names, the split note half first and then the raw string, with
/// the heading to scroll to (`resolveWikiTarget`).
pub fn resolve_target(
    data: &Connection,
    target: &str,
) -> Result<Option<(LinkTarget, Option<String>)>, StorageError> {
    let Some((found, heading)) = WikiNames::load_for(data, [target])?.resolve_target(target) else {
        return Ok(None);
    };
    Ok(targets(data, vec![Some(found)])?
        .pop()
        .flatten()
        .map(|target| (target, heading)))
}

/// The matches as targets, read in one statement. A match whose note went between the two
/// reads is `None`.
fn targets(
    data: &Connection,
    found: Vec<Option<WikiMatch>>,
) -> Result<Vec<Option<LinkTarget>>, StorageError> {
    let notes = note_rows(
        data,
        found
            .iter()
            .flatten()
            .filter(|found| found.journal_date.is_none())
            .map(|found| found.id.as_str()),
    )?;
    let days = file_paths(
        data,
        found
            .iter()
            .flatten()
            .filter(|found| found.journal_date.is_some())
            .map(|found| found.id.as_str()),
    )?;
    Ok(found
        .into_iter()
        .map(|found| {
            let found = found?;
            if let Some(date) = found.journal_date {
                return Some(LinkTarget {
                    path: days.get(&found.id).cloned(),
                    id: found.id,
                    title: date.clone(),
                    journal_date: Some(date),
                    folder_path: None,
                    file_type: "markdown".to_owned(),
                    matched_by: found.matched_by,
                });
            }
            let row = notes.get(&found.id)?.clone();
            Some(LinkTarget {
                id: found.id,
                title: row.title,
                journal_date: None,
                folder_path: row.folder_path,
                file_type: row.file_type,
                path: row.path,
                matched_by: found.matched_by,
            })
        })
        .collect())
}

#[derive(Clone)]
struct NoteRow {
    title: String,
    folder_path: Option<String>,
    file_type: String,
    path: Option<String>,
}

/// The `note_files` path of each id among `ids` a row names, in one statement.
fn file_paths<'a>(
    data: &Connection,
    ids: impl Iterator<Item = &'a str>,
) -> Result<HashMap<String, String>, StorageError> {
    let ids = id_list(ids)?;
    let mut statement = data
        .prepare(
            "SELECT note_id, path FROM note_files \
             WHERE note_id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![ids], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

fn note_rows<'a>(
    data: &Connection,
    ids: impl Iterator<Item = &'a str>,
) -> Result<HashMap<String, NoteRow>, StorageError> {
    let ids = id_list(ids)?;
    let mut statement = data
        .prepare(
            "SELECT n.id, n.title, n.folder_path, COALESCE(f.file_type, n.file_type), f.path \
             FROM notes n LEFT JOIN note_files f ON f.note_id = n.id \
             WHERE n.deleted_at IS NULL AND n.id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![ids], |row| {
            Ok((
                row.get::<_, String>(0)?,
                NoteRow {
                    title: row.get(1)?,
                    folder_path: row.get(2)?,
                    file_type: row.get(3)?,
                    path: row.get(4)?,
                },
            ))
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

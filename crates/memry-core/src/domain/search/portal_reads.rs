//! What a portal's source shows about its readers, and the blocks a portal search finds
//! (desktop `portals/portal-service.ts`: `getPortalUsage`, `searchPortalBlocks`).
//!
//! Usage reads the rows the reindex derives ([`super::block_refs`]): a host per note whose
//! `memry-portal` fences show the source (or one block of it), then a host per note that links to
//! it, to one block of it with an anchor. A note's references into itself are left out, and so is
//! a host that is not a live note or day with a file.
//!
//! Search picks at most [`CANDIDATE_CAP`] notes (the full-text index for a text query, the tag
//! index for a tag alone), then reads each one's blocks from its document, since a block id
//! exists only there.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::journal_ops::links::id_list;
use crate::domain::note_list::NoteSort;
use crate::domain::wiki_target::WikiNames;
use crate::domain::{note_stats, reads, tag_reads, vault_locks};
use crate::portal::{extract_anchor, list_doc_blocks, strip_anchor};

use super::{HitKind, NOTES_RANK, failed, links::target_id, note_kind};

/// Notes a search opens at most; each one costs a document replay.
pub const CANDIDATE_CAP: usize = 40;

/// A tag-only search shows a note's first blocks, so one note cannot fill the list.
const TAG_ONLY_BLOCKS_PER_NOTE: usize = 5;

const MEMRY_NOTE: &str = "memry://note/";

/// How a host shows the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    /// Through portals; `ordinal` is the first matching fence among the host's portal fences.
    Portal { ordinal: u32 },
    /// Through a `[[Note#^anchor]]` link, or, without an anchor, any wiki link.
    Link,
}

/// A note that shows a source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalHost {
    pub note_id: String,
    pub title: String,
    pub path: String,
    /// Portal fences (or 1 for a link) in the host that point at the source.
    pub count: u32,
    pub kind: HostKind,
}

/// One block a portal search found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalBlockHit {
    pub note_id: String,
    pub title: String,
    pub path: String,
    pub block_id: String,
    pub anchor: Option<String>,
    /// The block's text without its anchor.
    pub text: String,
    /// The enclosing block's text, for the `Note › Parent` path in the picker.
    pub parent_text: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PortalBlockSearch {
    pub results: Vec<PortalBlockHit>,
    /// More blocks matched than the limit, or a tag alone matched more notes than
    /// [`CANDIDATE_CAP`].
    pub truncated: bool,
    /// Candidate notes whose document did not replay, with why: skipped, for the shell to log.
    pub unreadable: Vec<(String, String)>,
}

struct Named {
    title: String,
    path: String,
    markdown: bool,
}

/// The live notes and days among `ids` that have a file, by id.
fn named(
    data: &Connection,
    ids: &BTreeSet<String>,
) -> Result<HashMap<String, Named>, StorageError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids = id_list(ids.iter().map(String::as_str))?;
    let mut statement = data
        .prepare(
            "SELECT n.id, n.title, COALESCE(f.file_type, n.file_type, 'markdown') = 'markdown', f.path \
             FROM notes n JOIN note_files f ON f.note_id = n.id \
             WHERE n.deleted_at IS NULL AND n.id IN (SELECT value FROM json_each(?1)) \
             UNION ALL \
             SELECT j.id, j.date, 1, f.path \
             FROM journal_entries j JOIN note_files f ON f.note_id = j.id \
             WHERE j.deleted_at IS NULL AND j.id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![ids], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Named {
                    title: row.get(1)?,
                    markdown: row.get::<_, Option<bool>>(2)?.unwrap_or(false),
                    path: row.get(3)?,
                },
            ))
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// The notes that show `note_id` through a portal, then the ones that link to it; with `anchor`,
/// only portals and links to that block. Each list is sorted by title.
pub fn usage(
    data: &Connection,
    index: &Connection,
    note_id: &str,
    anchor: Option<&str>,
) -> Result<Vec<PortalHost>, StorageError> {
    let mut statement = index
        .prepare(
            "SELECT host_note_id, COUNT(DISTINCT ordinal), MIN(ordinal) FROM portal_refs
             WHERE source_note_id = ?1 AND host_note_id <> ?1 AND (?2 IS NULL OR anchor = ?2)
             GROUP BY host_note_id",
        )
        .map_err(failed)?;
    let portals: Vec<(String, u32, u32)> = statement
        .query_map(params![note_id, anchor], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let linking = linking_notes(data, index, note_id, anchor)?;

    let ids: BTreeSet<String> = portals
        .iter()
        .map(|(id, ..)| id.clone())
        .chain(linking.iter().cloned())
        .collect();
    let names = named(data, &ids)?;
    let host = |id: &str, count: u32, kind: HostKind| {
        names.get(id).map(|name| PortalHost {
            note_id: id.to_owned(),
            title: name.title.clone(),
            path: name.path.clone(),
            count,
            kind,
        })
    };
    let by_title = |a: &PortalHost, b: &PortalHost| {
        (a.title.as_str(), a.note_id.as_str()).cmp(&(b.title.as_str(), b.note_id.as_str()))
    };
    let mut hosts: Vec<PortalHost> = portals
        .iter()
        .filter_map(|(id, count, ordinal)| host(id, *count, HostKind::Portal { ordinal: *ordinal }))
        .collect();
    hosts.sort_by(by_title);
    let mut links: Vec<PortalHost> = linking
        .iter()
        .filter_map(|id| host(id, 1, HostKind::Link))
        .collect();
    links.sort_by(by_title);
    hosts.extend(links);
    Ok(hosts)
}

/// The other notes linking to `note_id`: to its block `anchor`, or with no anchor, at all.
fn linking_notes(
    data: &Connection,
    index: &Connection,
    note_id: &str,
    anchor: Option<&str>,
) -> Result<BTreeSet<String>, StorageError> {
    let Some(anchor) = anchor else {
        let mut statement = index
            .prepare("SELECT DISTINCT source_id FROM note_links WHERE target_id = ?1 AND source_id <> ?1")
            .map_err(failed)?;
        let sources = statement
            .query_map(params![note_id], |row| row.get::<_, String>(0))
            .map_err(failed)?;
        return sources.collect::<Result<_, _>>().map_err(failed);
    };
    let mut statement = index
        .prepare(
            "SELECT source_note_id, target FROM block_link_refs
             WHERE anchor = ?1 AND source_note_id <> ?2",
        )
        .map_err(failed)?;
    let rows: Vec<(String, String)> = statement
        .query_map(params![anchor, note_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    if rows.is_empty() {
        return Ok(BTreeSet::new());
    }
    let names = WikiNames::load(data)?;
    Ok(rows
        .into_iter()
        .filter(|(_, target)| match target.strip_prefix(MEMRY_NOTE) {
            Some(id) => id == note_id,
            None => target_id(&names, target).as_deref() == Some(note_id),
        })
        .map(|(source, _)| source)
        .collect())
}

/// The note ids a search reads, best first, and whether more notes matched than it reads.
fn candidates(
    data: &Connection,
    index: &Connection,
    text: Option<&str>,
    tag: Option<&str>,
) -> Result<Vec<String>, StorageError> {
    let tagged = match tag {
        Some(tag) => {
            let files = note_stats::file_tags(index)?;
            let tagged = tag_reads::tagged(data, &files, tag, false, NoteSort::Modified, false)?;
            Some(
                tagged
                    .notes
                    .into_iter()
                    .map(|note| note.id)
                    .collect::<Vec<_>>(),
            )
        }
        None => None,
    };
    let Some(text) = text else {
        return Ok(tagged.unwrap_or_default());
    };
    // Electron `searchAll`: a tag filter fetches five times the cap, then keeps the cap, so a text
    // search never reads more than the cap and is never truncated by its notes.
    let fetch = if tagged.is_some() {
        CANDIDATE_CAP * 5
    } else {
        CANDIDATE_CAP
    };
    let notes = markdown_notes(data, index, text, fetch)?;
    let tagged: Option<BTreeSet<String>> = tagged.map(|ids| ids.into_iter().collect());
    Ok(notes
        .into_iter()
        .filter(|id| tagged.as_ref().is_none_or(|ids| ids.contains(id)))
        .take(CANDIDATE_CAP)
        .collect())
}

/// The first `want` live markdown notes `text` matches, best first. Electron's `searchNotes`
/// drops journal days and other file types before its LIMIT, so a better-ranked day or PDF never
/// takes a note's place: the index is read in growing pages until `want` notes or its end.
fn markdown_notes(
    data: &Connection,
    index: &Connection,
    text: &str,
    want: usize,
) -> Result<Vec<String>, StorageError> {
    let Some(expression) = match_expression(text) else {
        return Ok(Vec::new());
    };
    let matching: i64 = index
        .query_row(
            "SELECT count(*) FROM fts_notes WHERE fts_notes MATCH ?1",
            params![expression],
            |row| row.get(0),
        )
        .map_err(failed)?;
    let mut limit = want;
    loop {
        let ids = ranked_notes(data, index, &expression, limit)?;
        let names = named(data, &ids.iter().cloned().collect())?;
        let notes: Vec<String> = ids
            .into_iter()
            .filter(|id| names.get(id).is_some_and(|name| name.markdown))
            .take(want)
            .collect();
        if notes.len() == want || limit as i64 >= matching {
            return Ok(notes);
        }
        limit *= 2;
    }
}

/// The live notes, journal days left out, among the first `limit` `fts_notes` rows `expression`
/// matches, best first.
fn ranked_notes(
    data: &Connection,
    index: &Connection,
    expression: &str,
    limit: usize,
) -> Result<Vec<String>, StorageError> {
    let mut statement = index
        .prepare(&format!(
            "SELECT id FROM fts_notes WHERE fts_notes MATCH ?1 ORDER BY {NOTES_RANK} LIMIT ?2"
        ))
        .map_err(failed)?;
    let ids = statement
        .query_map(params![expression, limit as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let mut notes = Vec::new();
    for id in ids {
        if matches!(note_kind(data, &id)?, Some(HitKind::Note { .. })) {
            notes.push(id);
        }
    }
    Ok(notes)
}

/// Every alphanumeric run of `query`, quoted, all required. The portal's own expression,
/// apart from the search sheet's [`super::query`].
fn match_expression(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{term}\""))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

/// Blocks matching a search portal's query: every lowercased word of `text` is in the block's
/// text; with only a tag, the first blocks of each tagged note. Locked notes are skipped, and so
/// is a note whose document does not replay ([`PortalBlockSearch::unreadable`]).
pub fn search_blocks(
    data: &Connection,
    index: &Connection,
    text: Option<&str>,
    tag: Option<&str>,
    limit: usize,
) -> Result<PortalBlockSearch, StorageError> {
    let terms: Vec<String> = text
        .unwrap_or_default()
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let mut seen = BTreeSet::new();
    let mut ids = candidates(data, index, text, tag)?;
    ids.retain(|id| seen.insert(id.clone()));
    let mut truncated = ids.len() > CANDIDATE_CAP;
    ids.truncate(CANDIDATE_CAP);
    let names = named(data, &ids.iter().cloned().collect())?;
    let mut results = Vec::new();
    let mut unreadable = Vec::new();
    for note_id in ids {
        if results.len() > limit {
            break;
        }
        let Some(name) = names.get(&note_id).filter(|name| name.markdown) else {
            continue;
        };
        if vault_locks::is_note_locked(data, &note_id, Some(&name.path))? {
            continue;
        }
        let blocks =
            reads::document_of(data, &note_id).and_then(|document| list_doc_blocks(&document));
        let blocks = match blocks {
            Ok(blocks) => blocks,
            Err(error) => {
                unreadable.push((note_id, error.to_string()));
                continue;
            }
        };
        let text_by_id: HashMap<&str, &str> = blocks
            .iter()
            .map(|block| (block.id.as_str(), strip_anchor(&block.text).trim()))
            .collect();
        let mut found = 0;
        for block in &blocks {
            let text = strip_anchor(&block.text).trim();
            if text.is_empty() {
                continue;
            }
            let lower = text.to_lowercase();
            if !terms.iter().all(|term| lower.contains(term.as_str())) {
                continue;
            }
            results.push(PortalBlockHit {
                note_id: note_id.clone(),
                title: name.title.clone(),
                path: name.path.clone(),
                block_id: block.id.clone(),
                anchor: extract_anchor(&block.text),
                text: text.to_owned(),
                parent_text: block
                    .parent_id
                    .as_deref()
                    .and_then(|id| text_by_id.get(id))
                    .filter(|text| !text.is_empty())
                    .map(|text| (*text).to_owned()),
            });
            found += 1;
            if terms.is_empty() && found == TAG_ONLY_BLOCKS_PER_NOTE {
                break;
            }
        }
    }
    if results.len() > limit {
        truncated = true;
        results.truncate(limit);
    }
    Ok(PortalBlockSearch {
        results,
        truncated,
        unreadable,
    })
}

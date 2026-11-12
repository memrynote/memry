//! Alias matches for note and journal search (#4319), after desktop's
//! `searchNoteNames` and `mergeNameHits` (`search-note-names.ts`).
//!
//! An alias is another name for a note or a journal day, kept in `data.db`
//! (`notes.aliases`, `journal_aliases.aliases`) and compared by [`name_key`],
//! as wiki links compare it. The whole query is one key: an alias equal to it
//! is an exact hit, one that starts with it a prefix hit. Exact hits lead the
//! list, a body hit the alias also found keeps its place and gains the alias
//! when its title does not already hold the query, and prefix hits follow the
//! rest. A hit names the alias it matched.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension as _, params};

use super::{HitKind, MatchKind, SearchHit, failed, note_kind};
use crate::api::errors::StorageError;
use crate::domain::notes::names::{name_key, parse_stored};

/// One alias the query names.
struct AliasHit {
    hit: SearchHit,
    exact: bool,
}

/// `hits` with the alias matches merged in, at most `limit` notes and
/// `limit` journals.
pub(super) fn merge_aliases(
    data: &Connection,
    index: &Connection,
    query: &str,
    hits: Vec<SearchHit>,
    limit: usize,
) -> Result<Vec<SearchHit>, StorageError> {
    let Some(key) = name_key(query) else {
        return Ok(hits);
    };
    let aliases = alias_hits(data, index, &key, limit)?;
    if aliases.is_empty() {
        return Ok(hits);
    }
    let by_id: HashMap<&str, &AliasHit> = aliases
        .iter()
        .map(|alias| (alias.hit.id.as_str(), alias))
        .collect();
    let mut found: Vec<SearchHit> = hits
        .into_iter()
        .map(|mut hit| {
            let named = by_id.get(hit.id.as_str());
            let holds_query = name_key(&hit.title).is_some_and(|title| title.contains(&key));
            if let Some(alias) = named.filter(|_| !holds_query) {
                hit.matched_name.clone_from(&alias.hit.matched_name);
            }
            hit
        })
        .collect();
    let exact: Vec<SearchHit> = aliases
        .iter()
        .filter(|alias| alias.exact)
        .map(
            |alias| match found.iter().position(|hit| hit.id == alias.hit.id) {
                Some(at) => found.remove(at),
                None => alias.hit.clone(),
            },
        )
        .collect();
    let exact_ids: HashSet<String> = exact.iter().map(|hit| hit.id.clone()).collect();
    let prefix: Vec<SearchHit> = aliases
        .into_iter()
        .filter(|alias| {
            !exact_ids.contains(&alias.hit.id) && !found.iter().any(|hit| hit.id == alias.hit.id)
        })
        .map(|alias| alias.hit)
        .collect();

    let (mut notes, mut journals) = (0, 0);
    let mut merged: Vec<SearchHit> = exact.into_iter().chain(found).chain(prefix).collect();
    merged.retain(|hit| {
        let count = match hit.kind {
            HitKind::Journal { .. } => &mut journals,
            _ => &mut notes,
        };
        *count += 1;
        *count <= limit
    });
    Ok(merged)
}

/// Every live note and journal day with an alias starting with `key`: exact
/// first, then the shortest alias, then by id, one hit per item, from the
/// first `limit` aliases. An item the index has no row for yet is left out,
/// as desktop's join over its index leaves it out.
fn alias_hits(
    data: &Connection,
    index: &Connection,
    key: &str,
    limit: usize,
) -> Result<Vec<AliasHit>, StorageError> {
    let mut named: Vec<(bool, usize, String, String)> = Vec::new();
    for (id, aliases) in stored_aliases(data)? {
        for alias in aliases {
            let Some(alias_key) = name_key(&alias) else {
                continue;
            };
            if alias_key.starts_with(key) {
                named.push((
                    alias_key == key,
                    alias_key.chars().count(),
                    id.clone(),
                    alias,
                ));
            }
        }
    }
    named.sort_by(|a, b| (!a.0, a.1, &a.2).cmp(&(!b.0, b.1, &b.2)));
    named.truncate(limit);

    let mut seen = HashSet::new();
    let mut hits = Vec::new();
    for (exact, _, id, alias) in named {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(kind) = note_kind(data, &id)? else {
            continue;
        };
        let title: Option<Option<String>> = index
            .query_row(
                "SELECT title FROM fts_notes WHERE id = ?1",
                params![&id],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?;
        let Some(title) = title else {
            continue;
        };
        hits.push(AliasHit {
            hit: SearchHit {
                id,
                title: title.unwrap_or_default(),
                kind,
                score: 0.0,
                snippet: Vec::new(),
                match_kind: MatchKind::Alias,
                matched_name: Some(alias),
            },
            exact,
        });
    }
    Ok(hits)
}

/// Each live note's and journal day's stored alias list. An unreadable list
/// is an error, not a note without aliases.
fn stored_aliases(data: &Connection) -> Result<Vec<(String, Vec<String>)>, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT id, aliases FROM notes WHERE deleted_at IS NULL AND aliases IS NOT NULL
             UNION ALL
             SELECT j.id, a.aliases FROM journal_entries j
             JOIN journal_aliases a ON a.journal_id = j.id
             WHERE j.deleted_at IS NULL AND a.aliases IS NOT NULL",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(failed)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, raw) = row.map_err(failed)?;
        let aliases = parse_stored(raw).map_err(|error| StorageError::Failed {
            what: format!("`{id}` has unreadable `aliases`: {error}"),
        })?;
        out.push((id, aliases));
    }
    Ok(out)
}

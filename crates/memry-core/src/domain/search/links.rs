//! One note's or journal day's outgoing wiki links, projected into
//! `note_links` (N800).
//!
//! Desktop's `extractWikiLinks` and `resolveNotesByTitles` are the reference.
//! A link is stored under its note half (`[[Note#Heading]]` is a link to
//! `Note`), and `[[#Heading]]`, a link to the note it sits in, is no edge.
//!
//! `target_id` is resolved here rather than at query time, and left `NULL`
//! when nothing carries that name or path — which is how a forward reference
//! to a note that does not exist yet survives until it is created. The target
//! is always stored, so the link is still a link in the meantime.
//!
//! `target_key` is the target's `name_key`, so [`reresolve`] can find the rows
//! a changed title, alias or path could move.

use std::collections::BTreeSet;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::crdt::blocks::Block;
use crate::domain::note_meta;
use crate::domain::notes::names::name_key;
use crate::domain::wiki_target::{self, WikiNames};

use super::failed;

pub(super) fn write(
    names: &WikiNames,
    index: &Connection,
    id: &str,
    blocks: &[Block],
) -> Result<(), StorageError> {
    // One row per distinct target: the primary key is (source_id,
    // target_title) and a note linking to the same place twice is still one
    // link between two notes. The mention count belongs to the reader.
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for block in blocks {
        let nodes = block.inline.iter().filter_map(|run| {
            let is_link = run
                .marks
                .iter()
                .any(|mark| mark == "wikiLink" || mark == "linkMention");
            run.target.clone().filter(|_| is_link)
        });
        for target in nodes.chain(super::literal_links::targets(block)) {
            let target = target.as_str();
            let (note, heading) = wiki_target::split(target);
            if note.is_empty() {
                continue;
            }
            seen.insert(
                if heading.is_some() {
                    note
                } else {
                    target.trim()
                }
                .to_owned(),
            );
        }
    }

    for title in seen {
        index
            .execute(
                "INSERT INTO note_links (source_id, target_id, target_title, target_key)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(source_id, target_title) DO UPDATE SET
                     target_id = excluded.target_id,
                     target_key = excluded.target_key",
                params![id, target_id(names, &title), title, name_key(&title)],
            )
            .map_err(failed)?;
    }
    Ok(())
}

pub(super) fn reresolve(
    names: &WikiNames,
    index: &Connection,
    changed: &BTreeSet<String>,
) -> Result<(), StorageError> {
    let mut keys = BTreeSet::new();
    let mut prefixes = BTreeSet::new();
    for id in changed {
        let (exact, starts) = names.link_keys(id);
        keys.extend(exact.iter().cloned());
        prefixes.extend(starts.iter().cloned());
    }
    let mut rows: BTreeSet<(String, String, Option<String>)> = BTreeSet::new();
    let mut collect = |sql: &str, bound: &[&dyn rusqlite::ToSql]| {
        let mut statement = index.prepare(sql).map_err(failed)?;
        let found = statement
            .query_map(bound, |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(failed)?;
        for row in found {
            rows.insert(row.map_err(failed)?);
        }
        Ok::<_, StorageError>(())
    };
    const SELECT: &str = "SELECT source_id, target_title, target_id FROM note_links WHERE ";
    let json = |set: &BTreeSet<String>| {
        serde_json::to_string(set).map_err(|error| StorageError::Failed {
            what: format!("link keys will not serialise: {error}"),
        })
    };
    collect(
        &format!("{SELECT}target_id IN (SELECT value FROM json_each(?1))"),
        &[&json(changed)?],
    )?;
    collect(
        &format!("{SELECT}target_key IN (SELECT value FROM json_each(?1))"),
        &[&json(&keys)?],
    )?;
    for prefix in prefixes {
        let end = format!("{}/", &prefix[..prefix.len() - 1]);
        collect(
            &format!("{SELECT}target_key >= ?1 AND target_key < ?2"),
            &[&prefix, &end],
        )?;
    }

    for (source_id, title, stored) in rows {
        let now = target_id(names, &title);
        if now != stored {
            index
                .execute(
                    "UPDATE note_links SET target_id = ?3 WHERE source_id = ?1 AND target_title = ?2",
                    params![source_id, title, now],
                )
                .map_err(failed)?;
        }
    }
    Ok(())
}

fn target_id(names: &WikiNames, title: &str) -> Option<String> {
    if let Some(found) = names.resolve(title) {
        return Some(found.id);
    }
    match note_meta::journal_date_of(title) {
        Some((date, true)) => names.journal_on(&date).map(str::to_owned),
        _ => None,
    }
}

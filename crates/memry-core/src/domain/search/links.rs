//! One note's or journal day's outgoing wiki links, projected into
//! `note_links` (N800).
//!
//! Desktop's `extractWikiLinks` and `resolveNotesByTitles` are the reference.
//! A link is stored under its note half (`[[Note#Heading]]` is a link to
//! `Note`), and `[[#Heading]]`, a link to the note it sits in, is no edge.
//!
//! `target_id` is resolved here rather than at query time, and left `NULL`
//! when nothing carries that title or path — which is how a forward reference
//! to a note that does not exist yet survives until it is created. The target
//! is always stored, so the link is still a link in the meantime.

use std::collections::BTreeSet;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::crdt::blocks::Block;
use crate::domain::{journal, note_meta, wiki_target};

use super::failed;

pub(super) fn write(
    data: &Connection,
    index: &Connection,
    id: &str,
    blocks: &[Block],
) -> Result<(), StorageError> {
    // One row per distinct target: the primary key is (source_id,
    // target_title) and a note linking to the same place twice is still one
    // link between two notes. The mention count belongs to the reader.
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for block in blocks {
        for run in &block.inline {
            let is_link = run
                .marks
                .iter()
                .any(|mark| mark == "wikiLink" || mark == "linkMention");
            let Some(target) = run.target.as_deref().filter(|_| is_link) else {
                continue;
            };
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
        // A path, then a title in any case (§12.3). Then a live journal whose date it spells, since desktop
        // titles a journal with its date.
        let target_id = match wiki_target::by_path_or_title(data, &title)? {
            Some(id) => Some(id),
            None => match note_meta::journal_date_of(&title) {
                Some((date, _)) => journal::live_entry(data, &date)?,
                None => None,
            },
        };
        index
            .execute(
                "INSERT INTO note_links (source_id, target_id, target_title)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(source_id, target_title) DO UPDATE SET
                     target_id = excluded.target_id",
                params![id, target_id, title],
            )
            .map_err(failed)?;
    }
    Ok(())
}

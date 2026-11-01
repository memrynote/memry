//! The desktop's tag reads: Electron's `getAllTagsWithCounts` (`database/queries/tags.ts`) and
//! `findNotesWithTagInfo` (`database/queries/notes/tag-queries.ts`).
//!
//! Electron reads a note's tags from its index of the file: the frontmatter `tags:` and the
//! body's `#tags`. Here they sit in three places, and a note carries their union by tag fold
//! (§13.7.7), in the order the note reads give it (`notes::read` on desktop):
//! - the record's `tags` (`note_tags`), which the app writes together with the file's header;
//! - the body's `#tags` (`note_body_tags`), parsed from the document;
//! - the file's header tags as the note index last measured them (`note_stats` in `index.db`,
//!   [`FileTags`]), the only place a file the open adopted carries them: the identity gives its
//!   record none.
//!
//! Only a note or journal day with a file row is counted or listed, as Electron's index holds
//! files only and the note list lists only those. A task counts with its own tags. Each item
//! counts once per tag, whatever spellings it carries.

use std::collections::{BTreeMap, HashMap};

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::note_list::NoteSort;
use crate::domain::note_stats::FileTags;
use crate::domain::notes::failed;
use crate::domain::tag_admin::{self, default_color};
use crate::domain::tags::{fold, tag_key};

/// One row of the tag list (`TagWithCount`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagCount {
    pub name: String,
    pub count: u32,
    pub color: String,
    pub icon: Option<String>,
    pub category_id: Option<String>,
    pub sort_order: i64,
}

/// A note or journal day carrying a tag, as a tag view lists it (`TagNoteItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaggedNote {
    pub id: String,
    pub path: String,
    /// A journal day's is its date, as Electron's index titles a day's file.
    pub title: String,
    pub emoji: Option<String>,
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
    pub tags: Vec<String>,
    pub word_count: u32,
    /// When the record pinned the tag to the note (`pinnedTags`), `None` when it did not.
    pub pinned_at: Option<i64>,
}

/// Each filed note by id, with when its record pinned each of its tags (by position).
type Filed = BTreeMap<String, (TaggedNote, Vec<Option<i64>>)>;

/// The live notes and journal days that have a file row, each with its tags. The record's
/// rows come with when each tag was pinned.
fn filed(data: &Connection, files: &HashMap<String, FileTags>) -> Result<Filed, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT f.note_id, f.path, COALESCE(n.title, j.date), n.emoji,
                    COALESCE(n.created_at, j.created_at), COALESCE(n.modified_at, j.modified_at)
               FROM note_files f
               LEFT JOIN notes n ON n.id = f.note_id AND n.deleted_at IS NULL
               LEFT JOIN journal_entries j ON j.id = f.note_id AND j.deleted_at IS NULL
              WHERE n.id IS NOT NULL OR j.id IS NOT NULL",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok(TaggedNote {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                emoji: row.get(3)?,
                created_at: row.get(4)?,
                modified_at: row.get(5)?,
                tags: Vec::new(),
                word_count: 0,
                pinned_at: None,
            })
        })
        .map_err(failed)?;
    let mut out = BTreeMap::new();
    for row in rows {
        let mut note = row.map_err(failed)?;
        note.word_count = files.get(&note.id).map_or(0, |file| file.word_count);
        out.insert(note.id.clone(), (note, Vec::new()));
    }
    let add = |out: &mut Filed, id: &str, tag: &str, pinned_at: Option<i64>| {
        if let Some((note, pins)) = out.get_mut(id)
            && !note.tags.iter().any(|kept| fold(kept) == fold(tag))
        {
            note.tags.push(tag.to_owned());
            pins.push(pinned_at);
        }
    };
    let mut statement = data
        .prepare(
            "SELECT note_id, tag, pinned_at FROM note_tags WHERE deleted_at IS NULL
              ORDER BY note_id, position",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(failed)?;
    for row in rows {
        let (id, tag, pinned_at): (String, String, Option<i64>) = row.map_err(failed)?;
        add(&mut out, &id, &tag, pinned_at);
    }
    let mut statement = data
        .prepare("SELECT note_id, tag FROM note_body_tags ORDER BY note_id, rowid")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?;
    for row in rows {
        let (id, tag): (String, String) = row.map_err(failed)?;
        add(&mut out, &id, &tag, None);
    }
    for (id, file) in files {
        for tag in &file.header_tags {
            add(&mut out, id, tag, None);
        }
    }
    Ok(out)
}

/// Each live task's tags, one spelling per tag.
fn task_tags(data: &Connection) -> Result<Vec<Vec<String>>, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT s.item_id, t.value FROM sync_items s, json_each(s.payload, '$.tags') t
              WHERE s.item_type = 'task' AND s.deleted_at IS NULL AND s.payload IS NOT NULL
                AND json_valid(s.payload) AND json_type(s.payload, '$.tags') = 'array'
                AND t.type = 'text'",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?;
    let mut by_task: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        let (id, tag): (String, String) = row.map_err(failed)?;
        let tags = by_task.entry(id).or_default();
        if !tags.iter().any(|kept| fold(kept) == fold(&tag)) {
            tags.push(tag);
        }
    }
    Ok(by_task.into_values().collect())
}

/// One tag's count, and the smallest spelling a note gives it, else a task (`min(tag)` of
/// Electron's two group-bys).
#[derive(Default)]
struct Tally {
    count: u32,
    note_name: Option<String>,
    task_name: Option<String>,
}

fn smallest(kept: &mut Option<String>, name: &str) {
    if kept.as_deref().is_none_or(|kept| name < kept) {
        *kept = Some(name.to_owned());
    }
}

/// Every tag in use, by count, then every tag nobody uses that someone made or styled
/// (`isAuthored`) at 0, by name. A tag no definition names takes the default colour of its name
/// (`defaultTagColorName`); Electron mints a definition on this read instead, coloured by how
/// many definitions the device holds, and collects the unauthored ones nobody uses. Here a read
/// writes nothing: those are only left out.
pub fn counts(
    data: &Connection,
    files: &HashMap<String, FileTags>,
) -> Result<Vec<TagCount>, StorageError> {
    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    for (note, _) in filed(data, files)?.values() {
        for tag in &note.tags {
            let tally = tallies.entry(tag_key(tag)).or_default();
            tally.count += 1;
            smallest(&mut tally.note_name, tag);
        }
    }
    for tags in task_tags(data)? {
        for tag in &tags {
            let tally = tallies.entry(tag_key(tag)).or_default();
            tally.count += 1;
            smallest(&mut tally.task_name, tag);
        }
    }
    let mut definitions = tag_admin::definitions(data)?;
    let mut used: Vec<TagCount> = Vec::new();
    for (key, tally) in tallies {
        let name = tally.note_name.or(tally.task_name).unwrap_or_default();
        let name = name.trim().to_owned();
        let definition = definitions.remove(&key);
        used.push(TagCount {
            color: definition
                .as_ref()
                .map_or_else(|| default_color(&name).to_owned(), |d| d.color.clone()),
            icon: definition.as_ref().and_then(|d| d.icon.clone()),
            category_id: definition.as_ref().and_then(|d| d.category_id.clone()),
            sort_order: definition.as_ref().map_or(0, |d| d.sort_order),
            count: tally.count,
            name,
        });
    }
    // Stable on the fold order the map gave: ties read alike on every open.
    used.sort_by_key(|tag| std::cmp::Reverse(tag.count));
    let mut made: Vec<TagCount> = definitions
        .into_values()
        .filter(|definition| definition.authored)
        .map(|definition| TagCount {
            name: definition.id,
            count: 0,
            color: definition.color,
            icon: definition.icon,
            category_id: definition.category_id,
            sort_order: definition.sort_order,
        })
        .collect();
    made.sort_by(|a, b| {
        fold(&a.name)
            .cmp(&fold(&b.name))
            .then_with(|| a.name.cmp(&b.name))
    });
    used.extend(made);
    Ok(used)
}

/// A tag's colour and its notes (`GetNotesByTagResponse`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagNotes {
    /// The definition's, or the default of the tag's name.
    pub color: String,
    pub notes: Vec<TaggedNote>,
}

/// Whether `tag` is `wanted` (`tagIs`), or under it when `descendants` (`tagOrUnder`).
fn matches(tag: &str, wanted: &str, descendants: bool) -> bool {
    let key = fold(tag);
    key == wanted || (descendants && key.starts_with(&format!("{wanted}/")))
}

/// The notes and journal days carrying `tag` (or a `/` descendant of it), pinned first by when
/// they were pinned, the rest by `sort` (`findNotesWithTagInfo`). A note's pin is the one its
/// record holds for its first matching tag.
pub fn tagged(
    data: &Connection,
    files: &HashMap<String, FileTags>,
    tag: &str,
    descendants: bool,
    sort: NoteSort,
    ascending: bool,
) -> Result<TagNotes, StorageError> {
    let wanted = fold(tag);
    let mut pinned = Vec::new();
    let mut rest = Vec::new();
    for (mut note, pins) in filed(data, files)?.into_values() {
        let Some(at) = note
            .tags
            .iter()
            .position(|kept| matches(kept, &wanted, descendants))
        else {
            continue;
        };
        note.pinned_at = pins[at];
        if note.pinned_at.is_some() {
            pinned.push(note);
        } else {
            rest.push(note);
        }
    }
    pinned.sort_by_key(|note| note.pinned_at);
    rest.sort_by(|a, b| {
        let order = match sort {
            NoteSort::Title => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
            NoteSort::Created => a.created_at.unwrap_or(0).cmp(&b.created_at.unwrap_or(0)),
            NoteSort::Modified => a.modified_at.unwrap_or(0).cmp(&b.modified_at.unwrap_or(0)),
        };
        if ascending { order } else { order.reverse() }
    });
    pinned.extend(rest);
    let color = tag_admin::definitions(data)?
        .remove(&tag_key(tag))
        .map_or_else(|| default_color(tag).to_owned(), |d| d.color);
    Ok(TagNotes {
        color,
        notes: pinned,
    })
}

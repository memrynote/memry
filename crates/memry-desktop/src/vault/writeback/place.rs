//! A pulled change to a note that has its file here (#5309): its title or folder moves the
//! file, its tags, other names and properties reach the file's frontmatter (Electron
//! `note-handler.ts` `applyUpsert`, markdown branch). The sync observer marks each pulled note
//! ([`Pulled`]); the note's next pass takes the mark, so a local edit never moves a file or
//! rewrites its frontmatter.
//!
//! In the pass, under the rows' lane, after its row, hash and file checks (a missing file is
//! kept missing, an outside edit not fed yet is kept, and the mark stays for the next pass):
//! - **Place** ([`Pass::place`]). The record's folder as the disk spells it, under the name its
//!   title makes ([`name_for`]) when the pull changed the title ([`Mark::title_before`]), else
//!   under the file's name byte for byte (Electron's `titleChanged`, `note-handler.ts:349`), numbered
//!   `<name> 1.md` on when another note or file holds it ([`free_target`]). A journal day is
//!   never placed: [`NoteFiles::placed`] reads notes only. A target that would make the note a
//!   journal day's file, a locked note, and a locked folder keep the file where it is. The move is
//!   the app's own ([`NoteFileMove`]): recorded in the core, both names told to the own-write
//!   record, the file moved without replacing anything (never a moment without it), then
//!   record, row and slot in one transaction ([`Lane::move_by_app`]; the record already holds
//!   the pulled place, so nothing is pushed), the file moved back when that fails, and a crash
//!   in between finished by the next open. [`Applied::Renamed`] follows: `Renamed` for a new
//!   name, `Moved` for a new folder alone. A move that fails keeps the file where it is: the
//!   pass still writes the frontmatter and the body there, and the mark waits for the next pass,
//!   [`PLACE_TRIES`] passes at most ([`Pulled::retry`]; Electron logs and goes on, L438-442).
//! - **Frontmatter** ([`patch`], inside `file_for`). `tags` when the set differs
//!   (case-insensitive), `aliases` when they differ, and each property value the record holds
//!   that the file does not. A file key goes only when the record lacks it and the property
//!   read takes it ([`text_values`]): a key the read does not take, a reserved key, `writing`
//!   and the cover keys stay as the file holds them.
//!
//! [`NoteFiles::placed`]: memry_core::api::note_files::NoteFiles::placed

use std::collections::{HashMap, HashSet};
use std::fmt::Display;
use std::sync::{Mutex, MutexGuard, PoisonError};

use memry_core::domain::note_files::Unfiled;
use memry_core::domain::note_stats::header_tags;
use memry_core::domain::notes::app_move::AppMoved;
use memry_core::markdown::frontmatter::{YamlMap, YamlValue, json_to_yaml, parse_markdown_note};

use super::Pass;
use crate::locks::Locks;
use crate::notes::frontmatter::{aliases, is_reserved_key};
use crate::notes::moves::{free_target, name_for, plain_folder};
use crate::notes::properties::{definition_types, text_values};
use crate::vault::app_move::NoteFileMove;
use crate::vault::config::read_vault_config_strict;
use crate::vault::consumer::rows::Lane;
use crate::vault::consumer::{Applied, MoveKind};
use crate::vault::journal_format::JournalDays;

const SCOPE: &str = "vault_writeback";

/// The passes a failed move of a pulled place is tried in, the first included.
pub(super) const PLACE_TRIES: u32 = 3;

/// The notes a pull changed whose pass has not taken the change yet.
#[derive(Default)]
pub(super) struct Pulled(Mutex<HashMap<String, Mark>>);

/// A pulled change a pass has not taken yet.
#[derive(Debug, Clone)]
pub(super) struct Mark {
    /// The note's title before the first pull since its file was last placed; `None` when the
    /// note was not here. The file takes the record's title only when it differs.
    pub(super) title_before: Option<String>,
    /// The passes whose move failed.
    failed: u32,
}

impl Pulled {
    /// A later pull keeps the first one's title: the file still carries that one.
    pub(super) fn mark(&self, note_id: &str, title_before: Option<&str>) {
        self.map().entry(note_id.to_owned()).or_insert(Mark {
            title_before: title_before.map(str::to_owned),
            failed: 0,
        });
    }

    pub(super) fn take(&self, note_id: &str) -> Option<Mark> {
        self.map().remove(note_id)
    }

    /// Gives `mark` back to the next pass: this one stopped before it took the change.
    pub(super) fn put_back(&self, note_id: &str, mark: Mark) {
        self.map().insert(note_id.to_owned(), mark);
    }

    /// A move that failed: the next pass tries it again, until [`PLACE_TRIES`] passes failed;
    /// then the file stays where it is until the next pull of the note.
    pub(super) fn retry(&self, note_id: &str, mut mark: Mark, why: &str) {
        mark.failed += 1;
        if mark.failed >= PLACE_TRIES {
            tracing::error!(
                scope = SCOPE,
                note_id,
                tries = mark.failed,
                "a pulled place is given up; the file stays where it is: {why}"
            );
            return;
        }
        tracing::warn!(
            scope = SCOPE,
            note_id,
            tries = mark.failed,
            "a pulled place waits for the next pass; the file stays where it is: {why}"
        );
        self.put_back(note_id, mark);
    }

    fn map(&self) -> MutexGuard<'_, HashMap<String, Mark>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A pulled record's frontmatter, for `file_for`: the record, and the property definitions'
/// types the file's values are read with.
pub(crate) struct Patch<'a> {
    pub(super) record: &'a Unfiled,
    pub(super) types: HashMap<String, String>,
}

/// The header tags of the file `text`, case folded; `None` when its frontmatter does not read.
pub(super) fn header_tags_of(text: &str) -> Option<HashSet<String>> {
    match parse_markdown_note(text).ok()?.frontmatter {
        YamlValue::Map(map) => Some(folded(&header_tags(&map))),
        _ => Some(HashSet::new()),
    }
}

fn folded(tags: &[String]) -> HashSet<String> {
    tags.iter().map(|tag| tag.to_lowercase()).collect()
}

/// The note's file as the pass found it: its path, and the hash its row names.
pub(super) struct Found<'a> {
    pub path: &'a str,
    pub file_hash: Option<&'a str>,
}

impl Pass {
    /// Moves the note's file to the place its record names; the new path, `None` when the file
    /// stays. `Err` with why when the move failed: the file and its row are where they were.
    pub(super) fn place(
        &self,
        lane: &mut Lane<'_>,
        note_id: &str,
        found: &Found<'_>,
        (record, title_before): (&Unfiled, Option<&str>),
    ) -> Result<Option<String>, String> {
        let root = self.root.as_path();
        let old = found.path;
        let (old_folder, name) = old.rsplit_once('/').unwrap_or(("", old));
        let new_name = match title_before == Some(record.title.as_str()) {
            true => name.to_owned(),
            false => name_for(name, &record.title),
        };
        let target = plain_folder(record.folder_path.as_deref().unwrap_or(""))
            .and_then(|folder| free_target(lane, root, note_id, old, &folder, &new_name));
        let new = match target {
            Ok(new) if new == old => return Ok(None),
            Ok(new) => new,
            Err(error) => return Ok(kept_in_place(note_id, error)),
        };
        let Ok(config) = read_vault_config_strict(root) else {
            return Ok(kept_in_place(
                note_id,
                "the vault's settings cannot be read",
            ));
        };
        let days = JournalDays::new(&config.journal_folder, &config.journal_date_format);
        if days.day_of(&new).is_some() {
            return Ok(kept_in_place(note_id, "the new path names a journal day"));
        }
        let locks = Locks::new(root, &self.vault);
        if let Err(error) = locks
            .refuse_note(note_id, old)
            .and_then(|()| locks.refuse_folder(folder_of(&new)))
        {
            return Ok(kept_in_place(note_id, error));
        }
        let writer = self
            .vault
            .notes_writer(self.store.clone())
            .map_err(|error| format!("the note's move: {error}"))?;
        let moved = AppMoved {
            old_path: old,
            new_path: &new,
            title: None,
            keeps_kind: true,
        };
        let file = NoteFileMove {
            echo: &self.echo,
            root,
            old,
            new: &new,
            hash: found.file_hash,
        };
        file.forward(lane, &writer, note_id, moved)
            .map_err(|error| format!("the note's file did not move: {error}"))?;
        if let Err(error) = lane.move_by_app(&writer, note_id, moved) {
            file.back(lane, &writer, note_id);
            return Err(format!("the note's row did not follow its file: {error}"));
        }
        let renamed = new_name != name;
        tracing::info!(
            scope = SCOPE,
            note_id,
            renamed,
            moved = folder_of(&new) != old_folder,
            "a pulled place moved the note's file"
        );
        lane.publish(Applied::Renamed {
            note_id: note_id.to_owned(),
            old_path: old.to_owned(),
            new_path: new.clone(),
            kind: if renamed {
                MoveKind::Renamed
            } else {
                MoveKind::Moved
            },
        });
        Ok(Some(new))
    }

    /// The file holds the record's property values now: a later outside edit is measured
    /// against them, so it does not take an older value back into the record.
    pub(super) fn wrote_pulled(&self, note_id: &str, record: &Unfiled) {
        let mut values = record.properties.clone();
        values.retain(|name, value| !is_reserved_key(name, value));
        if let Err(error) = self
            .vault
            .note_files()
            .file_properties_written(note_id, values)
        {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "the file's property baseline did not move: {error}"
            );
        }
    }

    /// Each defined property's type, for the read [`patch`] measures the file with.
    pub(super) fn property_types(&self) -> HashMap<String, String> {
        definition_types(&self.root, &self.vault, self.store.clone())
    }
}

fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

/// A place the file is not moved to: the note keeps its file where it is, and the pass goes on
/// to its frontmatter and body.
fn kept_in_place(note_id: &str, why: impl Display) -> Option<String> {
    tracing::warn!(
        scope = SCOPE,
        note_id,
        "a pulled place was not given to the note's file: {why}"
    );
    None
}

/// Gives `map`, the frontmatter of the file `raw`, what `record` holds that it does not;
/// whether it changed. `types` are the property definitions' types.
pub(super) fn patch(
    map: &mut YamlMap,
    record: &Unfiled,
    raw: &str,
    types: &HashMap<String, String>,
) -> bool {
    let mut changed = false;
    if folded(&header_tags(map)) != folded(&record.tags) {
        set_list(map, "tags", &record.tags);
        changed = true;
    }
    if aliases(map) != record.aliases {
        set_list(map, "aliases", &record.aliases);
        changed = true;
    }
    let Some(held) = text_values(raw, types) else {
        return changed;
    };
    for (name, value) in &record.properties {
        if !is_reserved_key(name, value) && held.get(name) != Some(value) {
            map.insert(name.clone(), json_to_yaml(value));
            changed = true;
        }
    }
    for name in held
        .keys()
        .filter(|name| !record.properties.contains_key(*name))
    {
        map.remove(name);
        if let Some(YamlValue::Map(nested)) = map.get("properties") {
            let mut nested = (**nested).clone();
            nested.remove(name);
            if nested.is_empty() {
                map.remove("properties");
            } else {
                map.insert("properties".to_owned(), YamlValue::map(nested));
            }
        }
        changed = true;
    }
    changed
}

fn set_list(map: &mut YamlMap, key: &str, items: &[String]) {
    if items.is_empty() {
        map.remove(key);
    } else {
        let items = items.iter().cloned().map(YamlValue::String).collect();
        map.insert(key.to_owned(), YamlValue::seq(items));
    }
}

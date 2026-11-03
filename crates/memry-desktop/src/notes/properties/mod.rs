//! A note's property values (`properties:get`, `set`, `merge` and `rename` of
//! `ipc/properties-handlers.ts`; Step 13k-3, #3530), for a note or a journal day alike.
//!
//! - **Read**: the values the note's file holds, typed and read as Electron's index gives them
//!   back ([`indexed_properties`]), each definition's type from `properties.md` and the records
//!   (13k-2). A large note's file is not parsed: its record's values are read instead.
//! - **Write**: the one writer of a note's property values. In the note's write turn, through
//!   the app-edit seam with [`Precondition::Held`]: the file's frontmatter block is edited in
//!   place ([`serialize_updated_note`]), so every key the edit leaves keeps its bytes and the body
//!   is not touched, then the note's document and row follow and the renderer hears of it as of
//!   an outside edit. A file the seam keeps (an outside edit not fed yet, a document ahead of
//!   its file) is refused with [`NotesError::EditKept`], and the user tries again. Once the file
//!   holds the edit, the record takes the file's values whole, in the same turn, so sync sends
//!   what the file says (`buildNotePushPayload` reads the index).
//!
//! What an edit makes of the frontmatter is [`edit`]. Not here: the header status a status
//! property takes from the note's tasks (`fillHeaderStatus`, Step 21), the `note_properties`
//! index and a type learned from a new value (13k-4), the journal page's own event for a day
//! (Step 13m), relation chips (`properties:resolveRefs`) and the lock check (Step 14).

pub mod edit;

use std::collections::HashMap;

use memry_core::domain::property_values::{IndexedProperty, indexed_properties};
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, deep_strict_equal, json_to_yaml, parse_markdown_note,
    serialize_updated_note,
};
use serde::Serialize;
use serde_json::{Map, Value};

use self::edit::{PropertyEdit, edited, user_properties};
use super::error::{NotesError, SCOPE};
use super::property_definitions::PropertyDefinitions;
use super::read::large_file_of;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Kept, Precondition};
use crate::vault::consumer::ChangeSource;
use crate::vault::file_types::FileType;
use crate::vault::note_file::read_note;

/// `PropertyValue` of `properties-api.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyValueView {
    pub name: String,
    pub value: Value,
    #[serde(rename = "type")]
    pub type_name: String,
}

/// A set's or a merge's answer (`SetPropertiesResponse` on success): the values as stored, and
/// the names the edit removed.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetPropertiesView {
    pub properties: Map<String, Value>,
    pub removed: Vec<String>,
}

impl NotesService {
    /// The note's property values, in its frontmatter's order; none for no note, a file that is
    /// gone or not markdown, or a frontmatter that does not parse (`parseNote` reads none).
    pub fn properties(
        &self,
        open: &OpenVault,
        note_id: &str,
    ) -> Result<Vec<PropertyValueView>, NotesError> {
        let files = open.vault.note_files();
        let Some(row) = files.by_id(note_id)? else {
            return Ok(Vec::new());
        };
        if row.file_type != FileType::Markdown.as_str() {
            return Ok(Vec::new());
        }
        let Some(file) = read_note(&open.path, &row.path)? else {
            return Ok(Vec::new());
        };
        let types = self.definition_types(open);
        if large_file_of(&file.raw).is_some() {
            let record = files
                .listed_by_id(note_id)?
                .map(|listed| listed.properties)
                .unwrap_or_default();
            let values: YamlMap = record
                .iter()
                .map(|(name, value)| (name.clone(), json_to_yaml(value)))
                .fold(YamlMap::new(), |mut map, (name, value)| {
                    map.insert(name, value);
                    map
                });
            return Ok(views(&values, &types));
        }
        let Ok(parsed) = file.parse() else {
            return Ok(Vec::new());
        };
        match &parsed.frontmatter {
            YamlValue::Map(map) => Ok(views(&user_properties(map), &types)),
            _ => Ok(Vec::new()),
        }
    }

    /// `properties:set`: the user's changes from `base`, the record they were shown, to
    /// `properties` ([`PropertyEdit::Set`]).
    pub fn set_properties(
        &self,
        open: &OpenVault,
        note_id: &str,
        properties: Map<String, Value>,
        base: Map<String, Value>,
    ) -> Result<SetPropertiesView, NotesError> {
        let edit = PropertyEdit::Set { properties, base };
        let (before, after) = self.edit_properties(open, note_id, &edit)?;
        let removed = before
            .into_iter()
            .filter(|name| !after.contains_key(name))
            .collect();
        Ok(SetPropertiesView {
            properties: after,
            removed,
        })
    }

    /// `properties:merge`: the given keys set, a `null` one removed.
    pub fn merge_properties(
        &self,
        open: &OpenVault,
        note_id: &str,
        values: Map<String, Value>,
    ) -> Result<SetPropertiesView, NotesError> {
        let removed = values
            .iter()
            .filter(|(_, value)| value.is_null())
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        let (_, after) = self.edit_properties(open, note_id, &PropertyEdit::Merge(values))?;
        Ok(SetPropertiesView {
            removed: removed
                .into_iter()
                .filter(|name| !after.contains_key(name))
                .collect(),
            properties: after,
        })
    }

    /// `properties:rename`, on this note only; the definition keeps its name.
    pub fn rename_property(
        &self,
        open: &OpenVault,
        note_id: &str,
        from: String,
        to: String,
    ) -> Result<(), NotesError> {
        self.edit_properties(open, note_id, &PropertyEdit::Rename { from, to })?;
        Ok(())
    }

    /// Runs `edit` on the note's file (see the module comment): the property names the file
    /// held, and the values it holds now, as stored.
    fn edit_properties(
        &self,
        open: &OpenVault,
        note_id: &str,
        edit: &PropertyEdit,
    ) -> Result<(Vec<String>, Map<String, Value>), NotesError> {
        let types = self.definition_types(open);
        let writer = open.vault.notes_writer(self.store.clone())?;
        let seam = AppEdit::new(&self.tier, &self.store, open)?;
        self.order.run(note_id, |turn| {
            let mut read = YamlMap::new();
            let mut next = YamlMap::new();
            let done = seam.run(turn, Precondition::Held, ChangeSource::AppEdit, |text| {
                let parsed = parse_markdown_note(text)?;
                read = match &parsed.frontmatter {
                    YamlValue::Map(map) => (**map).clone(),
                    _ if parsed.raw_frontmatter_block.is_none() => YamlMap::new(),
                    // A top level that is a list or a scalar is the author's; no key goes in.
                    _ => return Err(NotesError::FrontmatterNotAMap),
                };
                next = edited(&read, edit)?;
                let changed = !deep_strict_equal(
                    &YamlValue::map(read.clone()),
                    &YamlValue::map(next.clone()),
                );
                if !changed {
                    return Ok(None);
                }
                let body = parsed.content.clone();
                Ok(Some(serialize_updated_note(
                    parsed,
                    &read,
                    next.clone(),
                    &body,
                    true,
                )?))
            })?;
            let held = indexed(&user_properties(&read), &types);
            let names = held.iter().map(|p| p.name.clone()).collect();
            match done {
                Edited::Wrote { .. } => {
                    let stored = stored(&indexed(&user_properties(&next), &types));
                    if !writer.file_properties(note_id, stored.clone())? {
                        tracing::warn!(
                            scope = SCOPE,
                            note_id,
                            "a note's file took a property edit its record could not: no record"
                        );
                    }
                    Ok((names, stored))
                }
                Edited::Unchanged => Ok((names, stored(&held))),
                Edited::Kept(Kept::NoRow | Kept::NoFile | Kept::NoBody) => {
                    Err(NotesError::NotFound(note_id.to_owned()))
                }
                Edited::Kept(Kept::NotMarkdown) => Err(NotesError::NotMarkdown),
                Edited::Kept(kept) => Err(NotesError::EditKept(kept)),
            }
        })
    }

    /// Each defined property's type, by name: `properties.md`, then the records. Without them
    /// (the file or the records unreadable) every type is inferred from its value.
    fn definition_types(&self, open: &OpenVault) -> HashMap<String, String> {
        let listed = open
            .vault
            .property_definition_records(self.store.clone())
            .map_err(|error| error.to_string())
            .and_then(|records| {
                PropertyDefinitions::new(open.path.clone(), records)
                    .list()
                    .map_err(|error| error.to_string())
            });
        match listed {
            Ok(definitions) => definitions
                .into_iter()
                .filter_map(|definition| {
                    let type_name = serde_json::to_value(definition.type_name).ok()?;
                    Some((definition.name, type_name.as_str()?.to_owned()))
                })
                .collect(),
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    "property types are inferred from their values: the definitions did not \
                     read: {error}"
                );
                HashMap::new()
            }
        }
    }
}

fn indexed(values: &YamlMap, types: &HashMap<String, String>) -> Vec<IndexedProperty> {
    indexed_properties(values.iter(), |name| types.get(name).cloned())
}

fn stored(properties: &[IndexedProperty]) -> Map<String, Value> {
    properties
        .iter()
        .map(|p| (p.name.clone(), p.value.clone()))
        .collect()
}

fn views(values: &YamlMap, types: &HashMap<String, String>) -> Vec<PropertyValueView> {
    indexed(values, types)
        .into_iter()
        .map(|p| PropertyValueView {
            name: p.name,
            value: p.value,
            type_name: p.type_name,
        })
        .collect()
}

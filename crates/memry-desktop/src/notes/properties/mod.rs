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
//!   its file) is refused with [`NotesError::EditKept`]. Once the file holds the edit, the
//!   record takes the keys the edit set or dropped, under the lane before the note event
//!   (`AppEdit::run_then`'s `landed`), so a refused write leaves it and sync sends the edit
//!   (`buildNotePushPayload` reads the index). Every other key keeps the record's value: a value
//!   a pull brought in is not in the file yet (13k-4), and the file's stale one must not go back.
//!
//! A template applied to a note (`notes:apply-template`, [`super::apply_template`]) and a link
//! rewrite in a frontmatter value (`super::link_rewrite`) mirror with [`mirror_properties`]
//! inside their own write. What an edit makes of the frontmatter is [`edit`]. The note index
//! reads the same values into `note_properties` ([`file_properties`]) and gives a name with no
//! definition the type it reads first (`learnCanonicalPropertyType`; `super::index`). Relation
//! chips (`properties:resolveRefs`) are [`resolve_refs`]'s.
//!
//! Not here: the header status a status property takes from the note's tasks
//! (`fillHeaderStatus`, Step 21), the journal page's own event for a day (Step 13m) and the lock
//! check (Step 14).

pub mod edit;
pub mod resolve_refs;

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::domain::property_values::{IndexedProperty, indexed_properties};
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, deep_strict_equal, json_to_yaml, parse_markdown_note,
    serialize_updated_note,
};
use memry_core::seams::secure_store::SecureStore;
use serde::Serialize;
use serde_json::{Map, Value};

use self::edit::{PropertyEdit, edited};
use super::error::{NotesError, SCOPE};
use super::frontmatter::user_properties;
use super::property_definitions::PropertyDefinitions;
use super::read::large_file_of;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Precondition};
use crate::vault::consumer::ChangeSource;
use crate::vault::file_types::FileType;
use crate::vault::note_file::{NoteFile, read_note};

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
        Ok(file_properties(&file, &types)
            .unwrap_or_default()
            .into_iter()
            .map(view)
            .collect())
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
            // The stored values the file held and holds after the edit, once the text decided.
            let values = RefCell::new(None::<(Map<String, Value>, Map<String, Value>)>);
            let done = seam.run_then(
                turn,
                Precondition::Held,
                ChangeSource::AppEdit,
                |text| {
                    let parsed = parse_markdown_note(text)?;
                    let read = match &parsed.frontmatter {
                        YamlValue::Map(map) => (**map).clone(),
                        _ if parsed.raw_frontmatter_block.is_none() => YamlMap::new(),
                        // A top level that is a list or a scalar is the author's; no key goes in.
                        _ => return Err(NotesError::FrontmatterNotAMap),
                    };
                    let next = edited(&read, edit)?;
                    *values.borrow_mut() = Some((
                        stored(&indexed(&user_properties(&read), &types)),
                        stored(&indexed(&user_properties(&next), &types)),
                    ));
                    let changed = !deep_strict_equal(
                        &YamlValue::map(read.clone()),
                        &YamlValue::map(next.clone()),
                    );
                    if !changed {
                        return Ok(None);
                    }
                    let body = parsed.content.clone();
                    Ok(Some(serialize_updated_note(
                        parsed, &read, next, &body, true,
                    )?))
                },
                // Under the lane once the file holds the edit, before the note event.
                || {
                    let values = values.borrow();
                    if let Some((held, after)) = values.as_ref() {
                        mirror_properties(&writer, note_id, (held.clone(), after.clone()))?;
                    }
                    Ok(false)
                },
                &mut || {},
            )?;
            let (held, after) = values.into_inner().unwrap_or_default();
            let names = held.keys().cloned().collect();
            match done {
                Edited::Wrote { .. } => Ok((names, after)),
                Edited::Unchanged { .. } => Ok((names, held)),
                Edited::Kept(kept) => {
                    tracing::info!(scope = SCOPE, note_id, ?kept, "a property edit was refused");
                    Err(NotesError::kept(note_id, kept))
                }
            }
        })
    }

    /// Each defined property's type, by name ([`definition_types`]).
    pub(crate) fn definition_types(&self, open: &OpenVault) -> HashMap<String, String> {
        definition_types(&open.path, &open.vault, self.store.clone())
    }
}

/// Each property's type, by name: `properties.md`, then the records, then the types this device
/// learned ([`PropertyDefinitions::types`]). Without them (the file or the records unreadable)
/// every type is inferred from its value.
pub fn definition_types(
    path: &Path,
    vault: &Vault,
    store: Arc<dyn SecureStore>,
) -> HashMap<String, String> {
    read_definition_types(path, vault, store).unwrap_or_else(|error| {
        tracing::warn!(
            scope = SCOPE,
            "property types are inferred from their values: the definitions did not read: {error}"
        );
        HashMap::new()
    })
}

/// [`definition_types`], or why they did not read.
pub fn read_definition_types(
    path: &Path,
    vault: &Vault,
    store: Arc<dyn SecureStore>,
) -> Result<HashMap<String, String>, String> {
    let records = vault
        .property_definition_records(store)
        .map_err(|error| error.to_string())?;
    PropertyDefinitions::new(path.to_owned(), records)
        .types()
        .map_err(|error| error.to_string())
}

/// The user properties the file's frontmatter holds, read as the index reads them; `None` for a
/// frontmatter that does not parse or is not a mapping, which `parseNote` reads as none (a file
/// with no frontmatter reads as an empty mapping).
pub fn file_properties(
    file: &NoteFile,
    types: &HashMap<String, String>,
) -> Option<Vec<IndexedProperty>> {
    text_properties(&file.raw, types)
}

fn text_properties(text: &str, types: &HashMap<String, String>) -> Option<Vec<IndexedProperty>> {
    match parse_markdown_note(text).ok()?.frontmatter {
        YamlValue::Map(map) => Some(indexed(&user_properties(&map), types)),
        _ => None,
    }
}

/// [`file_properties`] as the record stores them.
pub(crate) fn file_values(
    file: &NoteFile,
    types: &HashMap<String, String>,
) -> Option<Map<String, Value>> {
    text_values(&file.raw, types)
}

/// [`file_values`] of a file's text.
pub(crate) fn text_values(
    text: &str,
    types: &HashMap<String, String>,
) -> Option<Map<String, Value>> {
    text_properties(text, types).map(|properties| stored(&properties))
}

/// A frontmatter edit's property values as the record stores them: what the file held, and what
/// it holds.
pub(crate) type EditedValues = (Map<String, Value>, Map<String, Value>);

/// Gives the record the keys a file edit set and dropped, under the lane once the file holds
/// the edit ([`NotesWriter::file_properties`], which keeps every other key and moves the file's
/// baseline).
pub(super) fn mirror_properties(
    writer: &NotesWriter,
    note_id: &str,
    (before, after): EditedValues,
) -> Result<(), NotesError> {
    if !writer.file_properties(note_id, before, after)? {
        tracing::warn!(
            scope = SCOPE,
            note_id,
            "a note's file took a property edit its record could not: no record"
        );
    }
    Ok(())
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

/// The property values, as stored, of a frontmatter edit from `read` to `next`, for
/// `NotesWriter::file_properties` under the lane once the file holds it. For a writer already
/// inside the note's turn (a journal save), which cannot take [`NotesService::set_properties`]'
/// turn.
pub(crate) fn edited_values(
    read: &YamlMap,
    next: &YamlMap,
    types: &HashMap<String, String>,
) -> EditedValues {
    (
        stored(&indexed(&user_properties(read), types)),
        stored(&indexed(&user_properties(next), types)),
    )
}

fn views(values: &YamlMap, types: &HashMap<String, String>) -> Vec<PropertyValueView> {
    indexed(values, types).into_iter().map(view).collect()
}

fn view(property: IndexedProperty) -> PropertyValueView {
    PropertyValueView {
        name: property.name,
        value: property.value,
        type_name: property.type_name,
    }
}

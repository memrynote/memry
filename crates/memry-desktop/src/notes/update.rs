//! A note edited in the app (`updateNote`, `vault/notes-crud.ts`, and `writeNoteCommand`,
//! `notes/domain.ts`): an editor save of its body, an edit of its header tags, its icon, and
//! named frontmatter keys (the cover and its framing, the full-width toggle; 13q-2).
//!
//! In the note's write order, through [`AppEdit`] with [`Precondition::Save`], which owns the
//! read, the version of what a save would lose, the feed, the file, the row and the order
//! against the watcher. This decides the text and the record:
//! 1. the next header tags ([`header_tags::next`]) against the file's: the `tags:` key is
//!    written only when [`header_tags::compare`] reports a change, so an unchanged list keeps
//!    the file's spelling, and every other key keeps its lines (`serialize_updated_note`);
//! 2. the named frontmatter keys: each set, a `null` one removed, every other key keeping its
//!    lines; the keys Memry manages (`tags`, `aliases`, the nested `properties` envelope, the
//!    document's `writing`) are refused, since each has its own edit;
//! 3. the new body, or the body read when the update has none;
//! 4. once the file holds them, the record's icon, its tags when the header changed, the
//!    property keys the frontmatter edit set or dropped (`file_delta`, the 13k-3 rule: every
//!    other key keeps the record's value) and its `cover` when the file's cover changed (one
//!    outbox row each), so a refused write leaves the record as the file says; the note event
//!    ([`ChangeSource::Save`]) reads them.
//!
//! Once the turn ends, a header tag the edit added may bring its template
//! ([`super::tag_template`], `applyTagTemplateAfterAdd`), in a turn of its own.
//!
//! Not here, with their owners: the title (`notes:rename`, refused here for good: Electron's
//! update renames the record and leaves the file, and no renderer sends one), `properties` and
//! `propertyPatch` (`properties:*`, 13k), `aliases` (`notes:edit-aliases`, 13q-1), date
//! reminders (Step 21) and locks (Step 14).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use memry_core::domain::body_tags;
use memry_core::domain::header_tags::{
    self, EditSource, Existing, HeaderTagEdit, HeaderTagRename, Update,
};
use memry_core::domain::note_stats::header_tags as file_header_tags;
use memry_core::domain::tags::{fold, tag_key};
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, deep_strict_equal, json_to_yaml, parse_markdown_note,
    serialize_updated_note,
};
use memry_core::markdown::shared::cover_image::cover_sync;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use super::error::{NotesError, SCOPE};
use super::frontmatter::cover_fields;
use super::properties::{file_delta, mirror_properties};
use super::read;
use super::service::NotesService;
use super::tag_template::TagTemplateOutcome;
use super::view::NoteView;
use super::write_order::NoteTurn;
use crate::session::OpenVault;
use crate::vault::app_edit::{Edited, Precondition};
use crate::vault::consumer::ChangeSource;

/// `HeaderTagEditSchema`: at most 50 names per list, each 1 to 50 UTF-16 units once trimmed.
const MAX_EDIT_TAGS: usize = 50;
const MAX_TAG_UNITS: usize = 50;

/// `NoteUpdateSchema`, the fields this step writes.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateInput {
    pub id: String,
    #[serde(default)]
    #[specta(optional)]
    pub content: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub header_tags: Option<HeaderTagEditInput>,
    /// Absent leaves the icon; `null` clears it.
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub emoji: Option<Option<String>>,
    /// Frontmatter keys to set, a `null` one removed; the rest keep their lines.
    #[serde(default)]
    #[specta(optional)]
    pub frontmatter: Option<Map<String, Value>>,
}

/// The frontmatter keys an update may not name, each with the edit that owns it. `writing` is
/// the note document's: a frontmatter-only save feeds no body, so the document would disagree
/// with its file and refuse every later held edit.
const MANAGED_KEYS: [(&str, &str); 4] = [
    ("tags", "headerTags"),
    ("aliases", "notes_edit_aliases"),
    ("properties", "properties_*"),
    ("writing", "the note's editor"),
];

/// `HeaderTagEditSchema`.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeaderTagEditInput {
    #[serde(default)]
    #[specta(optional)]
    pub add: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub remove: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub rename: Option<Vec<HeaderTagRenameInput>>,
    #[serde(default)]
    #[specta(optional)]
    pub source: Option<HeaderTagSource>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct HeaderTagRenameInput {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum HeaderTagSource {
    Inline,
}

/// A field that is present, `null` included; `#[serde(default)]` makes an absent one `None`.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

impl HeaderTagEditInput {
    fn checked(self) -> Result<HeaderTagEdit, NotesError> {
        let name = |tag: &String| {
            let units = tag.trim().encode_utf16().count();
            (1..=MAX_TAG_UNITS).contains(&units)
        };
        let (add, remove, rename) = (
            self.add.unwrap_or_default(),
            self.remove.unwrap_or_default(),
            self.rename.unwrap_or_default(),
        );
        let fits = add.len() <= MAX_EDIT_TAGS
            && remove.len() <= MAX_EDIT_TAGS
            && rename.len() <= MAX_EDIT_TAGS
            && add.iter().chain(&remove).all(name)
            && rename.iter().all(|r| name(&r.from) && name(&r.to));
        if !fits {
            return Err(NotesError::InvalidTags);
        }
        Ok(HeaderTagEdit {
            add,
            remove,
            rename: rename
                .into_iter()
                .map(|r| HeaderTagRename {
                    from: r.from,
                    to: r.to,
                })
                .collect(),
            source: self
                .source
                .map(|HeaderTagSource::Inline| EditSource::Inline),
        })
    }
}

/// What an update came to.
#[derive(Debug)]
pub struct Updated {
    pub note: NoteView,
    /// The note's header tags or its body's `#tags` changed (`notes:tags-changed`).
    pub tags_changed: bool,
    /// What a header tag the edit added did with its template ([`super::tag_template`]).
    pub tag_template: Option<TagTemplateOutcome>,
}

/// An update, checked.
struct Edit {
    id: String,
    content: Option<String>,
    header_tags: Option<HeaderTagEdit>,
    emoji: Option<Option<String>>,
    frontmatter: Option<Map<String, Value>>,
}

impl NotesService {
    pub fn update(&self, open: &OpenVault, input: NoteUpdateInput) -> Result<Updated, NotesError> {
        self.update_checked(open, input, &mut || {})
    }

    /// [`Self::update`] with a hook that runs after the new file is written aside and before
    /// the checks ahead of its rename, so a test can edit the file in that window.
    #[doc(hidden)]
    pub fn update_checked(
        &self,
        open: &OpenVault,
        input: NoteUpdateInput,
        between: &mut dyn FnMut(),
    ) -> Result<Updated, NotesError> {
        let edit = Edit {
            header_tags: input
                .header_tags
                .map(HeaderTagEditInput::checked)
                .transpose()?,
            id: input.id,
            content: input.content,
            emoji: input.emoji,
            frontmatter: input.frontmatter,
        };
        let managed = edit
            .frontmatter
            .iter()
            .flat_map(Map::keys)
            .find_map(|key| MANAGED_KEYS.iter().find(|(managed, _)| managed == key));
        if let Some(&(key, owner)) = managed {
            return Err(NotesError::ManagedKey { key, owner });
        }
        // The property types a frontmatter edit's record mirror stores values with, read before
        // the note's turn as the property writer reads them.
        let types = match edit.frontmatter.is_some() {
            true => self.definition_types(open),
            false => HashMap::new(),
        };
        let (tags_changed, added) = self.order.run(&edit.id, |turn| {
            self.update_now(open, &edit, &types, turn, between)
        })?;
        // `addedInOrder`: the added tags in the order the caller asked for them.
        let added = match edit.header_tags.as_ref().filter(|e| !e.add.is_empty()) {
            None => added,
            Some(asked) => {
                let added: HashSet<String> = added.iter().map(|tag| tag_key(tag)).collect();
                let asked = asked.add.iter().filter(|tag| added.contains(&tag_key(tag)));
                asked.cloned().collect()
            }
        };
        let tag_template = match added.is_empty() {
            true => None,
            false => self.tag_template_after_add(open, &edit.id, &added),
        };
        let note = read::get(open, &edit.id, None)?
            .ok_or_else(|| NotesError::NotFound(edit.id.clone()))?;
        Ok(Updated {
            note,
            tags_changed,
            tag_template,
        })
    }

    fn update_now(
        &self,
        open: &OpenVault,
        edit: &Edit,
        types: &HashMap<String, String>,
        turn: &NoteTurn<'_>,
        between: &mut dyn FnMut(),
    ) -> Result<(bool, Vec<String>), NotesError> {
        let id = edit.id.as_str();
        let writer = open.vault.notes_writer(self.store.clone())?;
        let with_fields = match edit.header_tags.is_some() || edit.content.is_some() {
            true => open.vault.tags_with_fields()?,
            false => HashSet::new(),
        };
        let app_edit = self.save_edit(open)?;
        // What the text decided, for the record once the file holds it.
        let planned = RefCell::new(None);
        let edited = app_edit.run_then(
            turn,
            Precondition::Save(&self.own_files),
            ChangeSource::Save,
            |text| {
                let listed = open
                    .vault
                    .note_files()
                    .listed_by_id(id)?
                    .ok_or_else(|| NotesError::NotFound(id.to_owned()))?;
                let (output, plan) = next_text(text, edit, &with_fields, types, listed.emoji)?;
                *planned.borrow_mut() = Some(plan);
                Ok(Some(output))
            },
            || {
                let plan = planned.borrow();
                let Some(plan) = plan.as_ref() else {
                    return Ok::<_, NotesError>(false);
                };
                if let Some(emoji) = &plan.emoji {
                    writer.set_icon(id.to_owned(), emoji.clone())?;
                }
                if let Some(tags) = &plan.tags {
                    writer.set_tags(id.to_owned(), tags.clone())?;
                }
                if let Some(delta) = &plan.properties {
                    mirror_properties(&writer, id, delta.clone())?;
                }
                if let Some(cover) = &plan.cover
                    && !writer.file_cover(id, cover.clone())?
                {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id = id,
                        "a note's file took a cover its record could not: no record"
                    );
                }
                Ok(plan.emoji.is_some())
            },
            between,
        )?;
        let plan = planned.into_inner();
        match edited {
            Edited::Wrote { .. } | Edited::Unchanged => {
                Ok(plan.map_or((false, Vec::new()), |plan| (plan.tags_changed, plan.added)))
            }
            Edited::Kept(kept) => {
                tracing::info!(scope = SCOPE, note_id = id, ?kept, "a save was refused");
                Err(NotesError::EditKept(kept))
            }
        }
    }
}

/// What an update writes to the record once the file holds it.
struct Plan {
    /// The new icon, when it is not the record's.
    emoji: Option<Option<String>>,
    /// The new header tags, when the list changed.
    tags: Option<Vec<String>>,
    /// The property keys the frontmatter edit set and dropped, when it touched any.
    properties: Option<(Map<String, Value>, Vec<String>)>,
    /// The file's cover as a push carries it, `None` for none, when it changed.
    cover: Option<Option<Map<String, Value>>>,
    /// The header tags or the body's `#tags` changed (`notes:tags-changed`).
    tags_changed: bool,
    /// The tags the header gained, by tag fold.
    added: Vec<String>,
}

/// The file's next text: `text`, the file without a byte order mark, with the update applied.
fn next_text(
    text: &str,
    edit: &Edit,
    with_fields: &HashSet<String>,
    types: &HashMap<String, String>,
    emoji: Option<String>,
) -> Result<(String, Plan), NotesError> {
    let parsed = parse_markdown_note(text)?;
    let frontmatter = match &parsed.frontmatter {
        YamlValue::Map(map) => (**map).clone(),
        _ => YamlMap::new(),
    };
    let before = file_header_tags(&frontmatter);
    let existing = Existing {
        header_tags: &before,
        content: &parsed.content,
    };
    let update = Update {
        header_tags: edit.header_tags.as_ref(),
        content: edit.content.as_deref(),
        ..Update::default()
    };
    let tags = header_tags::next(&existing, &update, with_fields);
    let change = header_tags::compare(&before, &tags);
    let mut patched = frontmatter.clone();
    for (name, value) in edit.frontmatter.iter().flatten() {
        match value {
            Value::Null => {
                patched.remove(name);
            }
            value => {
                patched.insert(name.clone(), json_to_yaml(value));
            }
        }
    }
    let keys_changed = !deep_strict_equal(
        &YamlValue::map(frontmatter.clone()),
        &YamlValue::map(patched.clone()),
    );
    let writes_keys = change.is_some() || keys_changed;
    if writes_keys && !matches!(parsed.frontmatter, YamlValue::Map(_)) {
        // A top level that is a list or a scalar is the author's; no key goes into it.
        return Err(NotesError::FrontmatterNotAMap);
    }
    let body_tags_changed = edit
        .content
        .as_deref()
        .is_some_and(|content| tag_keys(&parsed.content) != tag_keys(content));
    let body = edit
        .content
        .clone()
        .unwrap_or_else(|| parsed.content.clone());
    let properties = keys_changed
        .then(|| file_delta(&frontmatter, &patched, types))
        .filter(|(changed, removed)| !changed.is_empty() || !removed.is_empty());
    let cover = keys_changed
        .then(|| {
            let held = cover_sync(&cover_fields(&frontmatter));
            let next = cover_sync(&cover_fields(&patched));
            (held != next).then_some(next)
        })
        .flatten();
    let mut next = patched;
    header_tags::set_tags(&mut next, &tags, change.as_ref());
    let tags_edited = change.is_some();
    let output = serialize_updated_note(parsed, &frontmatter, next, &body, writes_keys)?;
    let plan = Plan {
        emoji: edit.emoji.clone().filter(|next| *next != emoji),
        tags: tags_edited.then_some(tags),
        properties,
        cover,
        tags_changed: tags_edited || body_tags_changed,
        added: change.map(|change| change.added).unwrap_or_default(),
    };
    Ok((output, plan))
}

/// A body's `#tags`, by tag fold.
pub(super) fn tag_keys(body: &str) -> HashSet<String> {
    body_tags::extract_markdown(body)
        .iter()
        .map(|tag| fold(tag))
        .collect()
}

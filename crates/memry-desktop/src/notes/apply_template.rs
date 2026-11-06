//! A template applied to a note that exists (`applyTemplateToNote`, `notes/apply-template.ts`,
//! and `buildTemplateApplyUpdate`, `notes/template-update.ts`; Step 13l-4, #3530).
//!
//! - **`body`**: the note's body becomes the template's, `{{title}}` filled with the note's
//!   title. Nothing else is asked for.
//! - **`full`**: the body, and the template's tags join the header, its property values fill
//!   the names the note does not hold (the note's win, `{ ...template, ...note }`), and its
//!   icon is the note's when the note has none. The note holds a name its file has, or its
//!   record alone: a value pulled from sync lives in the record until the pull writes the file
//!   (13k-4), and the apply writes that value into the file instead of the template's.
//!
//! Either way the new body's `#tags` join the header and the old body's leave it, as Electron's
//! `updateNote` reads a body change (`header_tags::next`), and every frontmatter key the apply
//! does not touch keeps its bytes (`serialize_updated_note`).
//!
//! The text goes through the app-edit seam ([`AppEdit`], [`Precondition::Replace`]): the file,
//! then the note's document, then its row, then a note event the renderer takes as an outside
//! edit (`ChangeSource::AppEdit`), so an open editor shows the template. Once the file holds
//! the text, and before that event, the record takes the icon, the header tags and the property
//! values, as `notes:update` writes them. A note whose file or document the seam keeps (an
//! outside edit not fed yet, an edit the document has and the file not) is refused as a save
//! is, and the user applies again. An apply that replaces the body keeps a version of the file
//! first, as Electron's `writeNote` keeps one before it, and as the seam keeps a save's: the
//! user's text can be brought back.
//!
//! Not here, with their owners: `plainChecklists` (Step 32; the renderer refuses it), the lock
//! check (Step 14) and a project property's task links (Step 21).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use memry_core::domain::header_tags::{self, Existing, HeaderTagEdit, Update};
use memry_core::domain::note_stats::header_tags as file_header_tags;
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, parse_markdown_note, serialize_updated_note,
};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::error::{NotesError, SCOPE};
use super::frontmatter::{is_reserved_key, user_properties};
use super::properties::edit::{PropertyEdit, edited};
use super::properties::{EditedValues, edited_values, mirror_properties};
use super::read;
use super::service::NotesService;
use super::update::{Updated, tag_keys};
use crate::session::OpenVault;
use crate::templates::{TemplateView, Templates};
use crate::vault::app_edit::{AppEdit, Edited, Precondition};
use crate::vault::consumer::ChangeSource;

/// `ApplyTemplateSchema.mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TemplateMode {
    Full,
    Body,
}

/// `ApplyTemplateSchema`, the fields this step reads.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyTemplateInput {
    pub note_id: String,
    pub template_id: String,
    pub mode: TemplateMode,
}

/// The note's next file and what its record takes from it.
#[derive(Debug, Default, PartialEq)]
pub struct Applied {
    pub text: String,
    /// The header tags, when the apply changed them.
    pub header_tags: Option<Vec<String>>,
    /// The file's property values before and after, as stored by the definitions' types: the
    /// record takes the keys they differ in once the file holds the text.
    pub properties: EditedValues,
    /// The header or the body's `#tags` changed (`notes:tags-changed`).
    pub tags_changed: bool,
}

/// The text a note file's `text` (without a byte order mark) becomes with `template` applied in
/// `mode`, for a note titled `title` whose record holds the property values `record`.
/// `with_fields` holds the keys of the tags with fields, whose body `#tags` stay out of the
/// header; `types` the property definitions' types, by name.
pub fn applied(
    text: &str,
    title: &str,
    record: &Map<String, Value>,
    template: &TemplateView,
    mode: TemplateMode,
    with_fields: &HashSet<String>,
    types: &HashMap<String, String>,
) -> Result<Applied, NotesError> {
    let parsed = parse_markdown_note(text)?;
    let reading = match &parsed.frontmatter {
        YamlValue::Map(map) => (**map).clone(),
        _ => YamlMap::new(),
    };
    let body = template.body_for(title);
    let full = mode == TemplateMode::Full;
    let before = file_header_tags(&reading);
    let add = HeaderTagEdit {
        add: template.tags.clone(),
        ..HeaderTagEdit::default()
    };
    let existing = Existing {
        header_tags: &before,
        content: &parsed.content,
    };
    let update = Update {
        header_tags: full.then_some(&add),
        content: Some(&body),
        ..Update::default()
    };
    let tags = header_tags::next(&existing, &update, with_fields);
    let change = header_tags::compare(&before, &tags);

    let mut next = reading.clone();
    header_tags::set_tags(&mut next, &tags, change.as_ref());
    if full {
        // The values the note does not hold: a record-only one (pulled, not in the file yet,
        // 13k-4) as the record holds it, then the template's, through the property writer's
        // edit (`writePropertiesToRoot`).
        let in_file = user_properties(&reading);
        let mut fill: Map<String, Value> = record
            .iter()
            .filter(|(name, value)| !in_file.contains_key(name) && !is_reserved_key(name, value))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        for (name, value) in template.note_properties()? {
            if !in_file.contains_key(&name) && !record.contains_key(&name) {
                fill.insert(name, value);
            }
        }
        let fill = PropertyEdit::Set {
            properties: fill,
            base: Map::new(),
        };
        next = edited(&next, &fill)?;
    }
    let properties = edited_values(&reading, &next, types);
    let edited = change.is_some() || properties.0 != properties.1;
    if edited && !matches!(parsed.frontmatter, YamlValue::Map(_)) {
        // A top level that is a list or a scalar is the author's; no key goes into it.
        return Err(NotesError::FrontmatterNotAMap);
    }
    let tags_changed = change.is_some() || tag_keys(&parsed.content) != tag_keys(&body);
    let text = serialize_updated_note(parsed, &reading, next, &body, edited)?;
    Ok(Applied {
        text,
        header_tags: change.map(|_| tags),
        properties,
        tags_changed,
    })
}

impl NotesService {
    pub fn apply_template(
        &self,
        open: &OpenVault,
        input: ApplyTemplateInput,
    ) -> Result<Updated, NotesError> {
        let id = input.note_id.as_str();
        let not_found = || NotesError::NotFound(id.to_owned());
        let templates =
            Templates::new(open.path.clone(), open.vault.templates(self.store.clone())?);
        let template = templates
            .get(&input.template_id)?
            .ok_or_else(|| NotesError::TemplateNotFound(input.template_id.clone()))?;
        let with_fields = open.vault.tags_with_fields()?;
        let types = self.definition_types(open);
        let writer = open.vault.notes_writer(self.store.clone())?;
        let edit = AppEdit::new(&self.tier, &self.store, open)?;
        let tags_changed = self.order.run(id, |turn| {
            let listed = open
                .vault
                .note_files()
                .listed_by_id(id)?
                .ok_or_else(not_found)?;
            let icon = template
                .icon
                .clone()
                .filter(|icon| !icon.is_empty())
                .filter(|_| input.mode == TemplateMode::Full)
                .filter(|_| listed.emoji.as_deref().is_none_or(str::is_empty));
            // What the text decided, for the record once the file holds it.
            let planned = RefCell::new(None);
            let edited = edit.run_then(
                turn,
                Precondition::Replace,
                ChangeSource::AppEdit,
                |text| {
                    let next = applied(
                        text,
                        &listed.title,
                        &listed.properties,
                        &template,
                        input.mode,
                        &with_fields,
                        &types,
                    )?;
                    let output = next.text.clone();
                    *planned.borrow_mut() = Some(next);
                    Ok::<_, NotesError>(Some(output))
                },
                || {
                    let mut plan = planned.borrow_mut();
                    let Some(plan) = plan.as_mut() else {
                        return Ok(false);
                    };
                    if let Some(icon) = &icon {
                        writer.set_icon(id.to_owned(), Some(icon.clone()))?;
                    }
                    if let Some(tags) = plan.header_tags.take() {
                        writer.set_tags(id.to_owned(), tags)?;
                    }
                    mirror_properties(&writer, id, std::mem::take(&mut plan.properties))?;
                    Ok(icon.is_some())
                },
                &mut || {},
            )?;
            let tags_changed = planned.into_inner().is_some_and(|plan| plan.tags_changed);
            match edited {
                Edited::Wrote { .. } | Edited::Unchanged => Ok(tags_changed),
                Edited::Kept(kept) => {
                    tracing::info!(
                        scope = SCOPE,
                        note_id = id,
                        ?kept,
                        "a template was not applied"
                    );
                    Err(NotesError::EditKept(kept))
                }
            }
        })?;
        let note = read::get(open, id, None)?.ok_or_else(not_found)?;
        Ok(Updated {
            note,
            tags_changed,
            tag_template: None,
            kept_outside_edit: false,
            saved_content: None,
        })
    }
}

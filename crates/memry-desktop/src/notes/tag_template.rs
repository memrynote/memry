//! The template a header tag brings (Electron `notes/tag-template.ts`; Step 13l-4, #3530): when
//! an edit adds header tags to a note that is not a journal day, the first added tag whose
//! schema names a template, its own or an ancestor's, either fills the note's empty body (the
//! template autofills) or is offered to the user. A filled body can be taken back while it is
//! still exactly what the tag put there.
//!
//! The body goes through the app-edit seam ([`AppEdit`], [`Precondition::Held`]) in its own
//! write turn after the edit's, as Electron's `replaceBodyIf` runs after `updateNote`: the template's body with
//! `{{title}}` filled, and no header tag moves with the body's `#tags` (`ignoreInlineTags`). A
//! body that is not empty, or a document ahead of its file (typing the write-back has not
//! written yet), keeps the note as it is and the template is offered instead: the user's text
//! always wins.
//!
//! The undo is held in memory, one per note, the 100 latest notes: its token and the hash of
//! the body as it was right after the fill. A later fill on the note replaces it; an undo
//! empties the body again only while it still hashes the same, and is spent either way.

use std::collections::VecDeque;
use std::sync::Mutex;

use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, parse_markdown_note, serialize_updated_note,
};
use serde::{Deserialize, Serialize};

use super::error::{NotesError, SCOPE};
use super::service::NotesService;
use crate::session::OpenVault;
use crate::templates::Templates;
use crate::vault::app_edit::{AppEdit, Edited, Precondition};
use crate::vault::consumer::ChangeSource;
use crate::vault::hash::content_hash;

const BOM: char = '\u{feff}';
/// `MAX_UNDOS`.
const MAX_UNDOS: usize = 100;

/// `NoteTagTemplateOutcome`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TagTemplateOutcome {
    #[serde(rename_all = "camelCase")]
    Applied {
        tag: String,
        undo_token: String,
    },
    Offered {
        tag: String,
    },
}

/// `UndoTagTemplateSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoTagTemplateInput {
    pub note_id: String,
    pub undo_token: String,
}

/// `UndoTagTemplateResponse.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum UndoStatus {
    Restored,
    Stale,
}

struct Undo {
    note_id: String,
    token: String,
    /// The hash of the body right after the fill.
    body_hash: String,
}

/// The live undos, oldest first.
#[derive(Default)]
pub(crate) struct Undos(Mutex<VecDeque<Undo>>);

impl Undos {
    fn remember(&self, undo: Undo) {
        let mut undos = self.0.lock().unwrap_or_else(|e| e.into_inner());
        undos.retain(|held| held.note_id != undo.note_id);
        undos.push_back(undo);
        while undos.len() > MAX_UNDOS {
            undos.pop_front();
        }
    }

    /// The note's undo when `token` is its token, spent.
    fn take(&self, note_id: &str, token: &str) -> Option<Undo> {
        let mut undos = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let at = undos
            .iter()
            .position(|held| held.note_id == note_id && held.token == token)?;
        undos.remove(at)
    }
}

/// A note file's `text` (without a byte order mark) with its body replaced by `body` when
/// `accepts` takes the body it has; every frontmatter key keeps its bytes. Also the new body's
/// hash.
fn with_body(
    text: &str,
    body: &str,
    accepts: impl FnOnce(&str) -> bool,
) -> Result<Option<(String, String)>, NotesError> {
    let parsed = parse_markdown_note(text)?;
    if !accepts(&parsed.content) {
        return Ok(None);
    }
    let reading = match &parsed.frontmatter {
        YamlValue::Map(map) => (**map).clone(),
        _ => YamlMap::new(),
    };
    let text = serialize_updated_note(parsed, &reading, reading.clone(), body, false)?;
    let body_hash = content_hash(&parse_markdown_note(&text)?.content);
    Ok(Some((text, body_hash)))
}

/// `body.trim() === ''`, with the byte order mark `String.prototype.trim` also strips.
fn is_blank(body: &str) -> bool {
    body.trim_matches(|c: char| c.is_whitespace() || c == BOM)
        .is_empty()
}

impl NotesService {
    /// `applyTagTemplateAfterAdd`: `added` are the tags the edit added to the header, in the
    /// order the caller asked for them. Never fails the edit it follows: a template that cannot
    /// be read is logged and nothing is offered.
    pub(super) fn tag_template_after_add(
        &self,
        open: &OpenVault,
        note_id: &str,
        added: &[String],
    ) -> Option<TagTemplateOutcome> {
        match self.fill_from_tag(open, note_id, added) {
            Ok(outcome) => outcome,
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "a tag's template was not applied: {error}"
                );
                None
            }
        }
    }

    fn fill_from_tag(
        &self,
        open: &OpenVault,
        note_id: &str,
        added: &[String],
    ) -> Result<Option<TagTemplateOutcome>, NotesError> {
        let writer = open.vault.notes_writer(self.store.clone())?;
        if writer.journal_date(note_id)?.is_some() {
            return Ok(None);
        }
        let store = open.vault.templates(self.store.clone())?;
        let Some(hit) = store.tag_template(added)? else {
            return Ok(None);
        };
        let templates = Templates::new(open.path.clone(), store);
        let Some(template) = templates.get(&hit.id)? else {
            tracing::warn!(
                scope = SCOPE,
                tag = hit.tag,
                template_id = hit.id,
                "a tag names a template that does not exist"
            );
            return Ok(None);
        };
        let offered = Some(TagTemplateOutcome::Offered {
            tag: hit.tag.clone(),
        });
        if !hit.autofill {
            return Ok(offered);
        }
        let Some(listed) = open.vault.note_files().listed_by_id(note_id)? else {
            return Ok(None);
        };
        let body = template.body_for(&listed.title);
        let edit = AppEdit::new(&self.tier, &self.store, open)?;
        let mut filled = None;
        let edited = self.order.run(note_id, |turn| {
            edit.run(turn, Precondition::Held, ChangeSource::AppEdit, |text| {
                let next = with_body(text, &body, is_blank)?;
                Ok::<_, NotesError>(next.map(|(text, hash)| {
                    filled = Some(hash);
                    text
                }))
            })
        })?;
        let (Edited::Wrote { .. }, Some(body_hash)) = (edited, filled) else {
            return Ok(offered);
        };
        let token = uuid::Uuid::new_v4().to_string();
        self.undos.remember(Undo {
            note_id: note_id.to_owned(),
            token: token.clone(),
            body_hash,
        });
        Ok(Some(TagTemplateOutcome::Applied {
            tag: hit.tag,
            undo_token: token,
        }))
    }

    /// `undoTagTemplate`: empties the body again, only while it is still exactly what the tag
    /// filled in.
    pub fn undo_tag_template(
        &self,
        open: &OpenVault,
        input: &UndoTagTemplateInput,
    ) -> Result<UndoStatus, NotesError> {
        let Some(undo) = self.undos.take(&input.note_id, &input.undo_token) else {
            return Ok(UndoStatus::Stale);
        };
        let id = input.note_id.as_str();
        let edit = AppEdit::new(&self.tier, &self.store, open)?;
        let untouched = |body: &str| content_hash(body) == undo.body_hash;
        let edited = self.order.run(id, |turn| {
            edit.run(turn, Precondition::Held, ChangeSource::AppEdit, |text| {
                Ok::<_, NotesError>(with_body(text, "", untouched)?.map(|(text, _)| text))
            })
        })?;
        Ok(match edited {
            Edited::Wrote { .. } => UndoStatus::Restored,
            Edited::Unchanged { .. } | Edited::Kept(_) => UndoStatus::Stale,
        })
    }
}

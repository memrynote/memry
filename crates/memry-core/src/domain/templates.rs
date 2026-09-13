//! Templates, and the note a template creates (T126, chapter 13 §13.7.6,
//! chapter 12 §12.1.2 and §12.2, data-model §A.3).
//!
//! **A template body is not markdown-parsed here.** The core owns
//! `extract_text` and nothing else (§12.1); markdown becomes a document only
//! inside the editor bundle, through `doc-load.seedMarkdown`. So applying a
//! template is three verbatim copies and no parse:
//!
//! 1. the template's `content` into the new note's payload `content`, which is
//!    §12.2's carve-out A — the one path where a client's markdown reaches a
//!    vault file, because desktop writes a remote create's `content` as the
//!    file body;
//! 2. the same bytes into `note_bodies.seed_markdown`, which is the only copy
//!    of what the user asked for until the editor seeds the document (§A.3);
//! 3. the template's `tags` onto the note.
//!
//! **Template `properties` are deliberately not applied.** §13.7.6 requires
//! the field to stay a `TemplatePropertySchema[]` and says note creation
//! throws otherwise, but no chapter states that element's shape or how it maps
//! onto `note.properties` — which §13.7.1 marks free-form, values only. Copying
//! it blind would write a shape no reader here can check, so the array rides
//! in the template payload untouched and nothing is projected onto the note.
//! Recorded as a gap rather than guessed.

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox::{self, Durable};

use super::notes::{
    self, NewNote, create_in, edit, insert_local, iso, next_clock, object, tombstone_local,
};

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "template";

/// What a new template carries.
#[derive(Debug, Clone, Copy)]
pub struct NewTemplate<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub description: Option<&'a str>,
    pub icon: Option<&'a str>,
    /// Held verbatim. Never parsed here.
    pub content: &'a str,
}

/// What note a template should produce.
#[derive(Debug, Clone, Copy)]
pub struct NoteFromTemplate<'a> {
    pub template_id: &'a str,
    pub note_id: &'a str,
    pub title: &'a str,
    /// `None` is the vault root.
    pub folder_path: Option<&'a str>,
}

/// Creates a template.
pub fn create(
    conn: &Connection,
    template: &NewTemplate<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, template.id),
        now_ms,
        |tx| {
            let at = iso(now_ms)?;
            let payload = object(json!({
                "name": template.name,
                "description": template.description,
                "icon": template.icon,
                "content": template.content,
                "clock": next_clock(&Default::default(), device_id)?,
                "createdAt": at,
                "modifiedAt": at,
            }));
            insert_local(tx, ITEM_TYPE, template.id, payload, now_ms)
        },
    )
}

/// Renames a template.
pub fn rename(
    conn: &Connection,
    template_id: &str,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        ITEM_TYPE,
        template_id,
        vec![("name", Change::set(name))],
        device_id,
        now_ms,
    )
}

/// Tombstones a template. Notes already created from it are untouched.
pub fn delete(
    conn: &Connection,
    template_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<()>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, template_id),
        now_ms,
        |tx| tombstone_local(tx, ITEM_TYPE, template_id, device_id, now_ms),
    )
}

/// Creates a note from a template.
///
/// The template is read and the note is written inside **one** transaction, so
/// a template deleted concurrently cannot produce a note seeded from bytes
/// that no longer exist.
pub fn create_note(
    conn: &Connection,
    request: &NoteFromTemplate<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::upsert(notes::ITEM_TYPE, request.note_id),
        now_ms,
        |tx| {
            let seed = seed_of(tx, request.template_id)?;
            create_in(
                tx,
                &NewNote {
                    id: request.note_id,
                    title: request.title,
                    folder_path: request.folder_path,
                    content: &seed.content,
                    tags: &seed.tags,
                },
                device_id,
                now_ms,
            )
        },
    )
}

/// The two fields a template contributes to a note.
struct Seed {
    content: String,
    tags: Vec<String>,
}

/// Reads them from the template's **stored payload**, never from its
/// projection row (§13.2 rule 4).
///
/// Every failure here is an error and none is a silent default: a template
/// whose `content` is not a string would otherwise produce an empty note and
/// look like the user's own doing.
fn seed_of(tx: &Connection, template_id: &str) -> Result<Seed, StorageError> {
    let Some(row) = sync_items::load(tx, ITEM_TYPE, template_id)? else {
        return Err(StorageError::Failed {
            what: format!("no template {template_id}"),
        });
    };
    if row.deleted_at.is_some() {
        return Err(StorageError::Failed {
            what: format!("template {template_id} is deleted"),
        });
    }
    let stored = notes::require_payload(tx, ITEM_TYPE, template_id)?;

    let content = match stored.object().get("content") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(_) => {
            return Err(StorageError::Failed {
                what: format!("template {template_id}: `content` is not a string"),
            });
        }
    };
    let tags = match stored.object().get("tags") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut tags = Vec::with_capacity(items.len());
            for item in items {
                let Some(tag) = item.as_str() else {
                    return Err(StorageError::Failed {
                        what: format!("template {template_id}: a `tags` element is not a string"),
                    });
                };
                tags.push(tag.to_owned());
            }
            tags
        }
        Some(_) => {
            return Err(StorageError::Failed {
                what: format!("template {template_id}: `tags` is not an array"),
            });
        }
    };
    Ok(Seed { content, tags })
}

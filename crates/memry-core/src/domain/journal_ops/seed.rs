//! Opening a day from a template (spec 005-journal JP022, D2, D4, D10).
//!
//! Desktop's rule (`hooks/use-journal-entry.ts`): an empty day whose weekday
//! resolves a template is created from it, with the substituted markdown as
//! the entry's content, the template's tags and its properties. A template
//! this device has not pulled yet is a miss the shell retries later.
//!
//! One transaction writes the day (created or revived), the create-time
//! `content` (chapter 12 §12.2 carve-out A) and `note_bodies.seed_markdown`,
//! the tags and properties, **and** the document seeded from the markdown
//! (JP022a, [`crate::crdt::markdown_seed`]) with its update row: the phone has
//! no editor bundle to seed it later, and a day holding only `seed_markdown`
//! would be unwritable there.

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::markdown_seed::{body_is_empty, seed_document};
use crate::crdt::registry::UpdateSink;
use crate::crdt::{DocumentRegistry, update_log};
use crate::domain::journal::{self, ITEM_TYPE};
use crate::domain::journal_rules::{
    JournalTemplateFormatted, JournalTemplateProperty, JournalTemplateSettings,
    JournalTemplateSource, apply_journal_template, js_trim, resolve_journal_template_id,
};
use crate::domain::{notes, settings, templates};
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::outbox;

/// What opening a day from a template did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum SeedOutcome {
    /// The day did not exist and was created from the template.
    Seeded { id: String },
    /// A deleted day was revived under its own id and filled from the template.
    Revived { id: String },
    /// The day already has a live entry, possibly seeded on another device.
    /// Nothing was written.
    AlreadyExists { id: String },
}

/// The template id that applies to `date`: its weekday's template when one is
/// set, else `journal.defaultTemplate` (`resolveJournalTemplateId`).
///
/// Weekday keys outside `"0"`..`"6"` and non-string values are ignored; an
/// explicit `null` falls back to the default, as does an empty id.
pub fn resolve_template_for(conn: &Connection, date: &str) -> Result<Option<String>, StorageError> {
    let date = journal::valid_date(date)?;
    let default_template = match settings::read(conn, "journal.defaultTemplate")? {
        Some(Value::String(id)) if !id.is_empty() => Some(id),
        _ => None,
    };
    let weekday_templates = match settings::read(conn, "journal.weekdayTemplates")? {
        Some(Value::Object(map)) => Some(
            map.into_iter()
                .filter(|(key, _)| matches!(key.as_str(), "0" | "1" | "2" | "3" | "4" | "5" | "6"))
                .filter_map(|(key, value)| match value {
                    Value::String(id) => Some((key, Some(id))),
                    Value::Null => Some((key, None)),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    };
    Ok(resolve_journal_template_id(
        &JournalTemplateSettings {
            default_template,
            weekday_templates,
        },
        date,
    ))
}

/// Creates or revives the day `date` from `template_id`, with `formatted`
/// holding the shell's locale strings for the substitution (D4).
///
/// - A day with a live entry is never seeded twice: [`SeedOutcome::AlreadyExists`],
///   nothing written.
/// - A template this vault does not hold (not pulled yet, or deleted) is
///   [`StorageError::NotFound`]; the shell retries later.
/// - A revived day gets the content, tags and properties merged into its own
///   payload; its document is seeded only when its body is still empty.
pub fn open_day_from_template(
    conn: &Connection,
    date: &str,
    template_id: &str,
    formatted: &JournalTemplateFormatted,
    device_id: &str,
    now_ms: i64,
) -> Result<SeedOutcome, StorageError> {
    let date = journal::valid_date(date)?.to_owned();
    if let Some(id) = journal::live_entry(conn, &date)? {
        return Ok(SeedOutcome::AlreadyExists { id });
    }

    let tx = conn.unchecked_transaction().map_err(notes::failed)?;
    let source = template_source(&tx, template_id)?;
    let applied = apply_journal_template(&source, &date, formatted);

    let opened = journal::open_day_in(&tx, &date, device_id, now_ms)?;
    let id = opened.id.clone();
    let mut changes = vec![("content", Change::set(applied.content.as_str()))];
    let stored = notes::require_payload(&tx, ITEM_TYPE, &id)?;
    if let Some(tags) = merged_tags(stored.object(), &applied.tags) {
        changes.push(("tags", Change::Set(tags)));
    }
    if let Some(properties) = merged_properties(&stored, &applied.properties) {
        changes.push(("properties", Change::Set(properties)));
    }
    sync_items::apply_local_edit_in(&tx, ITEM_TYPE, &id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, &id), now_ms)?;
    notes::seed_body(&tx, &id, &applied.content, now_ms)?;
    seed_body_document(&tx, &id, &applied.content, device_id, now_ms)?;
    tx.commit().map_err(notes::failed)?;

    Ok(if opened.revived {
        SeedOutcome::Revived { id }
    } else {
        SeedOutcome::Seeded { id }
    })
}

/// The template's seedable parts, read from its stored payload. A template
/// missing here or deleted is `NotFound`.
fn template_source(
    tx: &Connection,
    template_id: &str,
) -> Result<JournalTemplateSource, StorageError> {
    let live = sync_items::load(tx, templates::ITEM_TYPE, template_id)?
        .is_some_and(|row| row.deleted_at.is_none() && row.payload.is_some());
    if !live {
        return Err(StorageError::NotFound {
            what: format!("template {template_id} is not on this device"),
        });
    }
    let seed = templates::seed_of(tx, template_id)?;
    Ok(JournalTemplateSource {
        content: seed.content,
        tags: seed.tags,
        properties: seed
            .properties
            .into_iter()
            .map(|(name, value)| JournalTemplateProperty { name, value })
            .collect(),
    })
}

/// The day's tags with the template's appended, `None` when nothing changes.
fn merged_tags(stored: &Map<String, Value>, template_tags: &[String]) -> Option<Value> {
    if template_tags.is_empty() {
        return None;
    }
    let mut tags: Vec<Value> = match stored.get("tags") {
        Some(Value::Array(existing)) => existing.clone(),
        _ => Vec::new(),
    };
    for tag in template_tags {
        if !tags.iter().any(|kept| kept.as_str() == Some(tag)) {
            tags.push(Value::String(tag.clone()));
        }
    }
    Some(Value::Array(tags))
}

/// The day's properties with the template's laid over them (D10), `None` when
/// the template has none. `date` is the journal's reserved property (D5) and
/// is never taken from a template.
fn merged_properties(
    stored: &StoredPayload,
    template_properties: &[JournalTemplateProperty],
) -> Option<Value> {
    let applied: Vec<&JournalTemplateProperty> = template_properties
        .iter()
        .filter(|property| property.name != "date")
        .collect();
    if applied.is_empty() {
        return None;
    }
    let mut properties = match stored.object().get("properties") {
        Some(Value::Object(existing)) => existing.clone(),
        _ => Map::new(),
    };
    for property in applied {
        properties.insert(property.name.clone(), property.value.clone());
    }
    Some(Value::Object(properties))
}

/// Seeds the day's document from `markdown` when its body is empty, and
/// queues the update with its log row, inside `tx`.
fn seed_body_document(
    tx: &Connection,
    id: &str,
    markdown: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if js_trim(markdown).is_empty() {
        return Ok(());
    }
    let authored: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| {
            authored
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(bytes.to_vec());
        })
    };
    let document = DocumentRegistry::new(device_id, sink)
        .get_or_open(id)
        .map_err(crdt_failed)?;
    for blob in update_log::load_plan(tx, id).map_err(crdt_failed)?.blobs() {
        document.apply_durable_update(blob).map_err(crdt_failed)?;
    }
    if !body_is_empty(&document).map_err(crdt_failed)? {
        return Ok(());
    }
    seed_document(&document, markdown).map_err(crdt_failed)?;

    let updates = std::mem::take(&mut *authored.lock().unwrap_or_else(PoisonError::into_inner));
    for update in updates {
        update_log::append_local_update_in(tx, id, &update, now_ms).map_err(crdt_failed)?;
        outbox::enqueue(
            tx,
            &outbox::Change::crdt_update(ITEM_TYPE, id, update),
            now_ms,
        )?;
    }
    Ok(())
}

fn crdt_failed(error: CrdtError) -> StorageError {
    match error {
        CrdtError::Storage { source } => source,
        other => StorageError::Failed {
            what: other.to_string(),
        },
    }
}

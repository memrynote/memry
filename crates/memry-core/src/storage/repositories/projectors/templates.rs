//! `template` (chapter 13 §13.7.6, data-model §A.4).
//!
//! `properties` must stay an array (`TemplatePropertySchema[]`) or note
//! creation from the template throws. A non-array from a differently versioned
//! peer is still stored verbatim in `sync_items.payload`; what the field table
//! below does is refuse to *project* it, so the failure lands as a corrupt row
//! at apply time rather than as a crash at note-creation time.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, clock_text, failed, instant, json, text, text_or_default};

const TEMPLATE_FIELDS: &[Field] = &[
    Field::opt("name", Kind::Text),
    Field::opt_null("description", Kind::Text),
    Field::opt_null("icon", Kind::Text),
    Field::opt("tags", Kind::TextArray),
    Field::opt("properties", Kind::Array),
    Field::opt("content", Kind::Text),
    Field::opt("clock", Kind::Clock),
    Field::opt("createdAt", Kind::Text),
    Field::opt("modifiedAt", Kind::Text),
];

pub fn read_template(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("template", parsed, TEMPLATE_FIELDS)
}

pub fn project_template(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO templates (
             id, name, description, icon, tags, properties, content, created_at,
             modified_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             icon = excluded.icon,
             tags = excluded.tags,
             properties = excluded.properties,
             content = excluded.content,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "name", ""),
            text(view, "description"),
            text(view, "icon"),
            json(view, "tags"),
            json(view, "properties"),
            text_or_default(view, "content", ""),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

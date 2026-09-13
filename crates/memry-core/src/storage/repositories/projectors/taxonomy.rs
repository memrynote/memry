//! `folder_config`, `custom_icon`, `tag_definition`, `tag_category` and
//! `property_definition` (chapter 13 §13.7.7 to §13.7.11, data-model §A.4).
//!
//! Three of these have ids that are not UUIDs: a `folder_config` id is a folder
//! path and a `tag_definition` id is a tag name (§13.6). The projection keys on
//! the id rather than on the payload's own `name`, because the id is the half
//! of `(type, id)` the rest of the sync bookkeeping uses, and a payload whose
//! `name` disagreed with its id would otherwise fork into two rows.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{
    ItemContext, clock_text, failed, flag, instant, number_or_default, text, text_or_default,
};

/// §13.7.10. `icon` is `z.string().nullable()` — the only non-optional field on
/// any subscribed type.
const FOLDER_CONFIG_FIELDS: &[Field] = &[
    Field::req_null("icon", Kind::Text),
    Field::opt("clock", Kind::Clock),
    Field::opt("createdAt", Kind::Text),
    Field::opt("modifiedAt", Kind::Text),
];

/// §13.7.11. `data` is base64 image bytes carried inline: a normalised icon is
/// a few KB, and keeping it in the record is what makes every device's icon
/// directory self-healing from the row.
const CUSTOM_ICON_FIELDS: &[Field] = &[
    Field::opt("name", Kind::Text),
    Field::opt("ext", Kind::Text),
    Field::opt("data", Kind::Text),
    Field::opt("clock", Kind::Clock),
    Field::opt("createdAt", Kind::Text),
    Field::opt("updatedAt", Kind::Text),
];

/// §13.7.7. `name` and `color` are required.
const TAG_DEFINITION_FIELDS: &[Field] = &[
    Field::req("name", Kind::Text),
    Field::req("color", Kind::Text),
    // `opt_null`, not `opt`: real desktop data writes `icon: null`, and 146
    // of 524 tag_definitions on the staging account did. Refusing them made
    // every one "corrupt" — which §13.3's forward tolerance and data-model
    // §A.4 both forbid: a projector substitutes the column default and never
    // refuses the item. No committed vector case carries a null `icon`, which
    // is why only real data found it.
    Field::opt_null("icon", Kind::Text),
    Field::opt_null("categoryId", Kind::Text),
    Field::opt("sortOrder", Kind::Number),
    Field::opt("colorAuthored", Kind::Bool),
    // `undefined` keeps the local value, `null` is an explicit clear (§13.4).
    Field::opt_null("views", Kind::Array),
    Field::opt("clock", Kind::Clock),
    Field::opt("createdAt", Kind::Text),
];

/// §13.7.8. `name` and `sortOrder` are required.
const TAG_CATEGORY_FIELDS: &[Field] = &[
    Field::req("name", Kind::Text),
    Field::req("sortOrder", Kind::Number),
    Field::opt("clock", Kind::Clock),
    Field::opt("createdAt", Kind::Text),
    Field::opt("updatedAt", Kind::Text),
    Field::opt_null("deletedAt", Kind::Text),
];

/// §13.7.9. `name` and `type` are required; `options` stays opaque JSON *text*,
/// deliberately not re-declared, so a newer client's per-option field is not
/// parsed away on a round trip. That is §13.2 applied inside one field.
const PROPERTY_DEFINITION_FIELDS: &[Field] = &[
    Field::req("name", Kind::Text),
    Field::req("type", Kind::Text),
    Field::opt_null("options", Kind::Text),
    Field::opt_null("defaultValue", Kind::Text),
    Field::opt_null("color", Kind::Text),
    Field::opt("clock", Kind::Clock),
    Field::opt("createdAt", Kind::Text),
];

pub fn read_folder_config(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("folder_config", parsed, FOLDER_CONFIG_FIELDS)
}

pub fn read_custom_icon(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("custom_icon", parsed, CUSTOM_ICON_FIELDS)
}

pub fn read_tag_definition(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("tag_definition", parsed, TAG_DEFINITION_FIELDS)
}

pub fn read_tag_category(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("tag_category", parsed, TAG_CATEGORY_FIELDS)
}

pub fn read_property_definition(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("property_definition", parsed, PROPERTY_DEFINITION_FIELDS)
}

pub fn project_folder_config(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let (parent_path, name) = split_path(item.item_id);
    conn.execute(
        "INSERT INTO folders (
             path, parent_path, name, icon, position, created_at, modified_at,
             clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(path) DO UPDATE SET
             parent_path = excluded.parent_path,
             name = excluded.name,
             icon = excluded.icon,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            parent_path,
            name,
            text(view, "icon"),
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

pub fn project_tag_definition(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    // Absent means "cannot tell" and the receiver honours the colour (§13.7.7),
    // which is the same outcome as an authored colour: only a sender that knows
    // the field can say `false`, and `false` is the one value that must not
    // repaint another device's tag.
    let color_authored = flag(view, "colorAuthored").unwrap_or(1);
    conn.execute(
        "INSERT INTO tag_definitions (
             name, color, color_authored, icon, category_id, sort_order, views,
             created_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(name) DO UPDATE SET
             color = excluded.color,
             color_authored = excluded.color_authored,
             icon = excluded.icon,
             category_id = excluded.category_id,
             sort_order = excluded.sort_order,
             views = excluded.views,
             created_at = excluded.created_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "color", ""),
            color_authored,
            text(view, "icon"),
            text(view, "categoryId"),
            number_or_default(view, "sortOrder", 0),
            super::json(view, "views"),
            instant(view, "createdAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

pub fn project_tag_category(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO tag_categories (
             id, name, sort_order, created_at, updated_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             sort_order = excluded.sort_order,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "name", ""),
            number_or_default(view, "sortOrder", 0),
            instant(view, "createdAt"),
            instant(view, "updatedAt"),
            clock_text(view),
            item.synced_at,
            // The item's own tombstone wins; the payload's `deletedAt` is the
            // fallback for a row whose delete travelled in the body.
            item.deleted_at.or_else(|| instant(view, "deletedAt")),
        ],
    )
    .map_err(failed)?;
    Ok(())
}

pub fn project_property_definition(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO property_definitions (
             name, type, options, default_value, color, created_at, clock,
             synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(name) DO UPDATE SET
             type = excluded.type,
             options = excluded.options,
             default_value = excluded.default_value,
             color = excluded.color,
             created_at = excluded.created_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "type", ""),
            // Stored exactly as the payload carries it: opaque text, not
            // re-encoded JSON.
            text(view, "options"),
            text(view, "defaultValue"),
            text(view, "color"),
            instant(view, "createdAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// `folders.parent_path` and `folders.name`, derived from the path so the tree
/// query does not string-split on every row (§A.4).
fn split_path(path: &str) -> (Option<String>, String) {
    match path.rsplit_once('/') {
        Some((parent, name)) => (Some(parent.to_owned()), name.to_owned()),
        None => (None, path.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_path_splits_into_a_parent_and_a_name() {
        assert_eq!(
            split_path("Notes/Protocol"),
            (Some("Notes".to_owned()), "Protocol".to_owned())
        );
        assert_eq!(split_path("Notes"), (None, "Notes".to_owned()));
    }
}

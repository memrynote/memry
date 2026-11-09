//! A note's tag fields (§13.7.7.1): the properties its tags' schemas list,
//! grouped per tag, with the value the note holds for each.
//!
//! Reads the schemas through [`tag_schema::resolve`], the twin of desktop's
//! `resolveTagSchemas` (`packages/app-core/src/tag-schema.ts`), and groups the
//! fields as `buildFieldGroups` (`renderer/src/features/tag-fields/build-field-groups.ts`) does.
//! A field carries no type: the vault-wide property definition owns it, and a
//! field with none reads as `text`. A field's value is an ordinary note
//! property, so a shell edits it through the property writes.
//!
//! A schema this build cannot read (a newer desktop wrote it) lists no fields,
//! as desktop treats an unreadable column: shown nowhere, never rewritten.

use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::note_meta::NoteProperty;
use crate::domain::properties::PropertyDefinition;
use crate::domain::tag_schema::{self, PropertyInfo, ResolvedField, ResolvedTag};
use crate::domain::tags;

/// Mirrors `RESERVED_FIELD_NAMES` in `packages/contracts/src/tag-schema.ts`.
const RESERVED: [&str; 12] = [
    "tags",
    "aliases",
    "properties",
    "project",
    "cover",
    "coverfocus",
    "coverfocusx",
    "coverzoom",
    "coverheight",
    "covercredit",
    "covercrediturl",
    "writing",
];

/// One field on a note: the property it names, typed by the vault's
/// definition, holding the note's value (`null` when the note has none yet).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TagField {
    pub property: NoteProperty,
    /// False when the note's payload has no key for this field yet.
    pub has_value: bool,
    /// A relation's target tag (lowercase); `None` = any note.
    pub relation_target: Option<String>,
    pub relation_many: bool,
}

/// One tag's fields on a note. A group a tag inherits names its parent in
/// `tag` and the note's tag in `via`, as desktop's "via #child" header does.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TagFieldGroup {
    /// The definition's stored casing.
    pub tag: String,
    pub color: String,
    pub icon: Option<String>,
    pub via: Option<String>,
    pub fields: Vec<TagField>,
}

fn fold(name: &str) -> String {
    name.trim().to_lowercase()
}

/// `isReservedFieldName`: a frontmatter key that is never a field.
pub(crate) fn is_reserved(name: &str) -> bool {
    RESERVED.contains(&fold(name).as_str())
}

/// `TagSchemaWire.safeParse`: the shape a field list is read from.
pub(crate) fn readable(schema: &Map<String, Value>) -> bool {
    let nullable_str = |v: Option<&Value>| v.is_none_or(|v| v.is_null() || v.is_string());
    let t_ok = schema
        .get("t")
        .and_then(Value::as_f64)
        .is_some_and(|t| t >= 0.0 && t.fract() == 0.0);
    let fields_ok = match schema.get("fields") {
        None => true,
        Some(Value::Array(fields)) => fields.iter().all(|field| {
            let Some(field) = field.as_object() else {
                return false;
            };
            let name_ok = field
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| (1..=200).contains(&n.encode_utf16().count()));
            let relation_ok = match field.get("relation") {
                None | Some(Value::Null) => true,
                Some(Value::Object(r)) => {
                    nullable_str(r.get("target"))
                        && r.get("many").is_none_or(Value::is_boolean)
                        && nullable_str(r.get("inverse"))
                        && r.get("inverse")
                            .and_then(Value::as_str)
                            .is_none_or(|s| s.encode_utf16().count() <= 100)
                }
                Some(_) => false,
            };
            name_ok && relation_ok
        }),
        Some(_) => false,
    };
    let template_ok = match schema.get("template") {
        None | Some(Value::Null) => true,
        Some(Value::Object(t)) => {
            t.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
                && t.get("autofill").is_none_or(Value::is_boolean)
        }
        Some(_) => false,
    };
    t_ok && fields_ok
        && template_ok
        && nullable_str(schema.get("extends"))
        && nullable_str(schema.get("preset"))
}

/// The keys of the tags with fields, their own or an ancestor's (desktop `tagsWithFields`, the
/// `hasFields` of `resolveTagSchemas`). A body's `#tag` of one of these never joins or leaves a
/// note's header ([`super::header_tags`]).
pub fn with_fields(conn: &Connection) -> Result<HashSet<String>, StorageError> {
    Ok(tag_schema::resolved(conn, &|_| None)?
        .into_iter()
        .filter(|(_, tag)| tag.has_fields)
        .map(|(key, _)| key)
        .collect())
}

/// The template a tag names, its own or the nearest ancestor's (the `template` of desktop
/// `resolveTagSchemas`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagTemplate {
    /// The tag of `item_tags` that names it, as given.
    pub tag: String,
    pub id: String,
    /// `autofill === true`: a note that gains the tag with an empty body takes the template.
    pub autofill: bool,
}

/// The first tag of `item_tags`, in order and by `tagKey`, whose schema names a template, its
/// own or the nearest ancestor's, and that template (desktop `firstTagTemplate`).
pub fn tag_template(
    conn: &Connection,
    item_tags: &[String],
) -> Result<Option<TagTemplate>, StorageError> {
    if item_tags.is_empty() {
        return Ok(None);
    }
    let resolved = tag_schema::resolved(conn, &|_| None)?;
    Ok(item_tags.iter().find_map(|tag| {
        let template = resolved.get(&tags::tag_key(tag))?.template.as_ref()?;
        Some(TagTemplate {
            tag: tag.clone(),
            id: template.id.clone(),
            autofill: template.autofill,
        })
    }))
}

/// The template a new note carrying `item_tags` takes when it names none (desktop `createNote`):
/// [`tag_template`]'s.
pub fn template_of(
    conn: &Connection,
    item_tags: &[String],
) -> Result<Option<String>, StorageError> {
    Ok(tag_template(conn, item_tags)?.map(|template| template.id))
}

/// The tag field groups of an item carrying `tags` and property `values`, in
/// the order desktop draws them: each tag's own fields, then each ancestor's,
/// nearest first. A field shown once is not shown again under a later tag.
pub fn groups(
    conn: &Connection,
    item_tags: &[String],
    values: &Map<String, Value>,
    properties: &[PropertyDefinition],
) -> Result<Vec<TagFieldGroup>, StorageError> {
    let definition = |name: &str| properties.iter().find(|d| d.name == name);
    let types = |name: &str| {
        definition(name).map(|d| PropertyInfo {
            type_name: d.type_name.clone(),
            options: None,
            show_on_calendar: None,
        })
    };
    let resolved = tag_schema::resolved(conn, &types)?;
    let mut shown: HashSet<String> = HashSet::new();
    let mut seen_tags = HashSet::new();
    let mut out = Vec::new();

    let slot = |field: &ResolvedField| {
        let definition = definition(&field.name);
        // The definition's options come along only when the field takes its type: not a
        // relation, and not a `project` or `relation` definition read as text.
        let options_json = definition
            .filter(|d| field.relation.is_none() && d.type_name == field.type_name)
            .and_then(|d| d.options.clone());
        let value = values.get(&field.name);
        TagField {
            has_value: value.is_some(),
            relation_target: field.relation.as_ref().and_then(|r| r.target.clone()),
            relation_many: field.relation.as_ref().is_some_and(|r| r.many),
            property: NoteProperty {
                value_json: value.unwrap_or(&Value::Null).to_string(),
                type_name: Some(field.type_name.clone()),
                options_json,
                color: definition.and_then(|d| d.color.clone()),
                name: field.name.clone(),
            },
        }
    };
    let mut group = |tag: &ResolvedTag, via: Option<&ResolvedTag>, fields: &[ResolvedField]| {
        let fields: Vec<TagField> = fields
            .iter()
            .filter(|f| shown.insert(f.name.clone()))
            .map(slot)
            .collect();
        if !fields.is_empty() {
            out.push(TagFieldGroup {
                tag: tag.name.clone(),
                color: tag.color.clone(),
                icon: tag.icon.clone(),
                via: via.map(|v| v.name.clone()),
                fields,
            });
        }
    };

    for name in item_tags {
        let key = tags::tag_key(name);
        if !seen_tags.insert(key.clone()) {
            continue;
        }
        let Some(tag) = resolved.get(&key) else {
            continue;
        };
        group(tag, None, &tag.own_fields);
        for inherited in &tag.inherited {
            if let Some(parent) = resolved.get(&inherited.from) {
                group(parent, Some(tag), &inherited.fields);
            }
        }
    }
    Ok(out)
}

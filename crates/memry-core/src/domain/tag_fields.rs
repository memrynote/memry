//! A note's tag fields (§13.7.7.1): the properties its tags' schemas list,
//! grouped per tag, with the value the note holds for each.
//!
//! Twin of desktop's `resolveTagSchemas` (`apps/desktop/src/main/tags/tag-schema.ts`)
//! and `buildFieldGroups` (`renderer/src/features/tag-fields/build-field-groups.ts`).
//! A field carries no type: the vault-wide property definition owns it, and a
//! field with none reads as `text`. A field's value is an ordinary note
//! property, so a shell edits it through the property writes.
//!
//! A schema this build cannot read (a newer desktop wrote it) lists no fields,
//! as desktop treats an unreadable column: shown nowhere, never rewritten.

use std::collections::{BTreeMap, HashSet};

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::note_meta::NoteProperty;
use crate::domain::properties::PropertyDefinition;
use crate::domain::{tag_admin, tags};

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

struct Def {
    name: String,
    color: String,
    icon: Option<String>,
    /// `None` when the column is absent or unreadable: no fields, no parent.
    schema: Option<Map<String, Value>>,
}

struct Field {
    name: String,
    relation: Option<(Option<String>, bool)>,
}

fn fold(name: &str) -> String {
    name.trim().to_lowercase()
}

/// `TagSchemaWire.safeParse`: the shape a field list is read from.
fn readable(schema: &Map<String, Value>) -> bool {
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

fn definitions(conn: &Connection) -> Result<BTreeMap<String, Def>, StorageError> {
    let mut out = BTreeMap::new();
    for (key, def) in tag_admin::definitions(conn)? {
        let schema = tag_admin::live_definition(conn, &def.id)?
            .and_then(|payload| payload.get("schema").and_then(Value::as_object).cloned())
            .filter(readable);
        out.insert(
            key,
            Def {
                name: def.id,
                color: def.color,
                icon: def.icon,
                schema,
            },
        );
    }
    Ok(out)
}

fn own_fields(def: Option<&Def>) -> Vec<Field> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let stored = def
        .and_then(|d| d.schema.as_ref())
        .and_then(|s| s.get("fields"))
        .and_then(Value::as_array);
    for field in stored.into_iter().flatten() {
        let Some(name) = field.get("name").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        let folded = fold(name);
        if name.is_empty() || RESERVED.contains(&folded.as_str()) || !seen.insert(folded) {
            continue;
        }
        let relation = field.get("relation").and_then(Value::as_object).map(|r| {
            let target = r
                .get("target")
                .and_then(Value::as_str)
                .map(tags::tag_key)
                .filter(|k| !k.is_empty());
            (target, r.get("many") == Some(&Value::Bool(true)))
        });
        out.push(Field {
            name: name.to_owned(),
            relation,
        });
    }
    out
}

fn ancestors(key: &str, defs: &BTreeMap<String, Def>) -> Vec<String> {
    let parent_of = |k: &str| {
        defs.get(k)
            .and_then(|d| d.schema.as_ref())
            .and_then(|s| s.get("extends"))
            .and_then(Value::as_str)
            .map(tags::tag_key)
    };
    let mut chain = Vec::new();
    let mut visited = HashSet::from([key.to_owned()]);
    let mut parent = parent_of(key);
    while let Some(next) = parent {
        if next.is_empty() || visited.contains(&next) || !defs.contains_key(&next) {
            break;
        }
        visited.insert(next.clone());
        parent = parent_of(&next);
        chain.push(next);
    }
    chain
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
    let defs = definitions(conn)?;
    let mut shown: HashSet<String> = HashSet::new();
    let mut seen_tags = HashSet::new();
    let mut out = Vec::new();

    let slots = |fields: Vec<Field>, shown: &mut HashSet<String>| -> Vec<TagField> {
        fields
            .into_iter()
            .filter(|f| shown.insert(f.name.clone()))
            .map(|f| {
                let definition = properties.iter().find(|d| d.name == f.name);
                let (type_name, options_json) = match (&f.relation, definition) {
                    (Some(_), _) => ("relation".to_owned(), None),
                    (None, Some(d)) if d.type_name != "project" && d.type_name != "relation" => {
                        (d.type_name.clone(), d.options.clone())
                    }
                    _ => ("text".to_owned(), None),
                };
                let value = values.get(&f.name);
                TagField {
                    has_value: value.is_some(),
                    relation_target: f.relation.as_ref().and_then(|r| r.0.clone()),
                    relation_many: f.relation.as_ref().is_some_and(|r| r.1),
                    property: NoteProperty {
                        value_json: value.unwrap_or(&Value::Null).to_string(),
                        type_name: Some(type_name),
                        options_json,
                        color: definition.and_then(|d| d.color.clone()),
                        name: f.name,
                    },
                }
            })
            .collect()
    };
    let group = |def: &Def, via: Option<&Def>, fields: Vec<TagField>| TagFieldGroup {
        tag: def.name.clone(),
        color: def.color.clone(),
        icon: def.icon.clone(),
        via: via.map(|d| d.name.clone()),
        fields,
    };

    for name in item_tags {
        let key = tags::tag_key(name);
        if !seen_tags.insert(key.clone()) {
            continue;
        }
        let Some(def) = defs.get(&key).filter(|d| d.schema.is_some()) else {
            continue;
        };
        let own = own_fields(Some(def));
        let mut listed: HashSet<String> = own.iter().map(|f| fold(&f.name)).collect();
        let own = slots(own, &mut shown);
        if !own.is_empty() {
            out.push(group(def, None, own));
        }
        for ancestor in ancestors(&key, &defs) {
            let parent = defs.get(&ancestor);
            let inherited: Vec<Field> = own_fields(parent)
                .into_iter()
                .filter(|f| listed.insert(fold(&f.name)))
                .collect();
            let (Some(parent), false) = (parent, inherited.is_empty()) else {
                continue;
            };
            let fields = slots(inherited, &mut shown);
            if !fields.is_empty() {
                out.push(group(parent, Some(def), fields));
            }
        }
    }
    Ok(out)
}

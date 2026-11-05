//! `applySchemaEdit` of `packages/app-core/src/tag-schema.ts`: one edit of one tag's stored
//! schema, stamped `t + 1` when it changes anything (`stampVersionedValue`). Keys a newer build
//! added survive, at every depth, because every edit works on the stored object.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::resolve::fold;
use super::{Relation, ResolvedTag};
use crate::domain::tag_fields::{is_reserved, readable};
use crate::domain::tag_schema_refs::rewrite_schema_reference;
use crate::domain::tags::tag_key;
use crate::sync::field_merge::canonical_json;
use crate::sync::versioned;

/// A field a schema gains (`NewFieldBody`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewField {
    pub name: String,
    pub relation: Option<Relation>,
}

impl NewField {
    fn stored(&self) -> Value {
        let mut field = Map::new();
        field.insert("name".into(), json!(self.name.trim()));
        if let Some(relation) = &self.relation {
            field.insert("relation".into(), relation.to_value());
        }
        Value::Object(field)
    }
}

/// `SchemaBodyEdit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemaEdit {
    AddField {
        field: NewField,
        index: Option<usize>,
    },
    SetRelation {
        name: String,
        relation: Option<Relation>,
    },
    RemoveField {
        name: String,
    },
    MoveField {
        name: String,
        to_index: usize,
    },
    RenameField {
        from: String,
        to: String,
        /// A recorded rename run again: a field already holding `to` takes the place of `from`.
        resuming: bool,
    },
    /// `(id, autofill)`; `None` clears it.
    SetTemplate {
        template: Option<(String, bool)>,
    },
    SetExtends {
        parent: Option<String>,
    },
    MergePreset {
        fields: Vec<NewField>,
        template: Option<(String, bool)>,
        preset: String,
    },
    RewriteReference {
        from: String,
        to: Option<String>,
    },
}

/// `SchemaEditError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemaEditError {
    ReservedName {
        name: String,
    },
    DuplicateField {
        name: String,
        defined_by: String,
    },
    UnknownField {
        name: String,
    },
    InheritedField {
        name: String,
        defined_by: String,
    },
    Cycle {
        parent: String,
    },
    UnreadableSchema,
    /// The result is a schema this build could not read back (`TagSchemaWire`): saved, it would
    /// lock the tag read-only on every device.
    Unwritable,
}

/// What an edit leaves stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Stamped {
    pub next: Map<String, Value>,
    pub changed: bool,
}

/// `stampVersionedValue` (§6.11.3), through the sync owner: `current` itself when `body` holds
/// the same content, else the body with `t` one past `current`'s.
fn stamp(current: Option<&Map<String, Value>>, body: Map<String, Value>) -> Stamped {
    let previous = current.map(|map| Value::Object(map.clone()));
    let next = versioned::stamp_value(previous.as_ref(), &body);
    Stamped {
        changed: current != Some(&next),
        next,
    }
}

fn canonical(map: &Map<String, Value>) -> String {
    canonical_json(&Value::Object(map.clone()))
}

fn clamp(index: usize, len: usize) -> usize {
    index.min(len)
}

/// The stored field's name, folded.
fn field_key(field: &Value) -> String {
    fold(field.get("name").and_then(Value::as_str).unwrap_or(""))
}

/// Applies `edit` to `tag`'s stored schema (`None` when it has none). `resolved` gives the
/// tag's inherited fields and every tag's ancestors.
pub fn apply(
    current: Option<&Map<String, Value>>,
    edit: &SchemaEdit,
    tag: &str,
    resolved: &BTreeMap<String, ResolvedTag>,
) -> Result<Stamped, SchemaEditError> {
    let key = tag_key(tag);
    let this = resolved.get(&key);
    if this.is_some_and(|t| !t.editable) {
        return Err(SchemaEditError::UnreadableSchema);
    }
    let base = current.cloned().unwrap_or_else(|| {
        let Value::Object(map) =
            json!({"t": 0, "fields": [], "template": null, "extends": null, "preset": null})
        else {
            unreachable!("a literal object")
        };
        map
    });
    let unchanged = || Stamped {
        next: base.clone(),
        changed: false,
    };

    if let SchemaEdit::RewriteReference { from, to } = edit {
        return match rewrite_schema_reference(&base, from, to.as_deref()) {
            Some(next) => written(Stamped {
                next,
                changed: true,
            }),
            None => Ok(unchanged()),
        };
    }

    let mut fields: Vec<Value> = base
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let index_of = |fields: &[Value], name: &str| {
        let wanted = fold(name);
        fields.iter().position(|f| field_key(f) == wanted)
    };
    let inherited_owner = |name: &str| {
        let wanted = fold(name);
        this?
            .inherited
            .iter()
            .find(|group| group.fields.iter().any(|f| fold(&f.name) == wanted))
            .map(|group| group.from.clone())
    };
    let missing = |name: &str| match inherited_owner(name) {
        Some(defined_by) => SchemaEditError::InheritedField {
            name: name.to_owned(),
            defined_by,
        },
        None => SchemaEditError::UnknownField {
            name: name.to_owned(),
        },
    };

    let mut body = base.clone();
    match edit {
        SchemaEdit::AddField { field, index } => {
            let name = field.name.trim();
            if is_reserved(name) {
                return Err(SchemaEditError::ReservedName {
                    name: name.to_owned(),
                });
            }
            if index_of(&fields, name).is_some() {
                return Err(SchemaEditError::DuplicateField {
                    name: name.to_owned(),
                    defined_by: key,
                });
            }
            if let Some(defined_by) = inherited_owner(name) {
                return Err(SchemaEditError::DuplicateField {
                    name: name.to_owned(),
                    defined_by,
                });
            }
            let at = clamp(index.unwrap_or(fields.len()), fields.len());
            fields.insert(at, field.stored());
        }
        SchemaEdit::SetRelation { name, relation } => {
            let at = index_of(&fields, name).ok_or_else(|| missing(name))?;
            if let Value::Object(field) = &mut fields[at] {
                field.shift_remove("relation");
                if let Some(relation) = relation {
                    field.insert("relation".into(), relation.to_value());
                }
            }
        }
        SchemaEdit::RemoveField { name } => {
            let at = index_of(&fields, name).ok_or_else(|| missing(name))?;
            fields.remove(at);
        }
        SchemaEdit::MoveField { name, to_index } => {
            let at = index_of(&fields, name).ok_or_else(|| missing(name))?;
            let moved = fields.remove(at);
            let to = clamp(*to_index, fields.len());
            fields.insert(to, moved);
        }
        SchemaEdit::RenameField { from, to, resuming } => {
            let to = to.trim();
            if is_reserved(to) {
                return Err(SchemaEditError::ReservedName {
                    name: to.to_owned(),
                });
            }
            let Some(at) = index_of(&fields, from) else {
                return Ok(unchanged());
            };
            let to_key = fold(to);
            let clash = fields
                .iter()
                .enumerate()
                .any(|(i, f)| i != at && field_key(f) == to_key);
            if clash {
                if !resuming {
                    return Err(SchemaEditError::DuplicateField {
                        name: to.to_owned(),
                        defined_by: key,
                    });
                }
                fields.remove(at);
            } else if let Value::Object(field) = &mut fields[at] {
                field.insert("name".into(), json!(to));
            }
        }
        SchemaEdit::SetTemplate { template } => {
            body.insert("template".into(), template_value(template.as_ref()));
        }
        SchemaEdit::SetExtends { parent } => {
            let parent = parent.as_deref().map(tag_key).filter(|p| !p.is_empty());
            if let Some(parent) = &parent {
                let closes = parent == &key
                    || resolved
                        .get(parent)
                        .is_some_and(|p| p.ancestors.contains(&key));
                if closes {
                    return Err(SchemaEditError::Cycle {
                        parent: parent.clone(),
                    });
                }
            }
            body.insert("extends".into(), parent.map_or(Value::Null, Value::String));
        }
        SchemaEdit::MergePreset {
            fields: added,
            template,
            preset,
        } => {
            let mut present: Vec<String> = fields.iter().map(field_key).collect();
            present.extend(
                this.iter()
                    .flat_map(|t| t.inherited.iter())
                    .flat_map(|group| group.fields.iter().map(|f| fold(&f.name))),
            );
            for field in added {
                let folded = fold(&field.name);
                if present.contains(&folded) || is_reserved(&field.name) {
                    continue;
                }
                present.push(folded);
                fields.push(field.stored());
            }
            if base.get("template").is_none_or(Value::is_null) {
                body.insert("template".into(), template_value(template.as_ref()));
            }
            if base.get("preset").is_none_or(Value::is_null) {
                body.insert("preset".into(), json!(preset));
            }
        }
        SchemaEdit::RewriteReference { .. } => unreachable!("handled above"),
    }
    if !matches!(
        edit,
        SchemaEdit::SetTemplate { .. } | SchemaEdit::SetExtends { .. }
    ) {
        body.insert("fields".into(), Value::Array(fields));
    }

    if current.is_none() && canonical(&body) == canonical(&base) {
        return Ok(unchanged());
    }
    written(stamp(current, body))
}

/// Refuses a result this build could not read back, so no edit stores a schema that resolves
/// read-only.
fn written(stamped: Stamped) -> Result<Stamped, SchemaEditError> {
    if readable(&stamped.next) {
        Ok(stamped)
    } else {
        Err(SchemaEditError::Unwritable)
    }
}

fn template_value(template: Option<&(String, bool)>) -> Value {
    template.map_or(
        Value::Null,
        |(id, autofill)| json!({"id": id, "autofill": autofill}),
    )
}

/// `canonicalFieldName`: the spelling an existing property of the same name has, else the typed
/// one, trimmed; `true` when it reused one.
pub fn canonical_field_name<'a>(
    typed: &str,
    existing: impl IntoIterator<Item = &'a str>,
) -> (String, bool) {
    let name = typed.trim();
    let wanted = fold(name);
    existing
        .into_iter()
        .find(|e| fold(e) == wanted)
        .map_or_else(|| (name.to_owned(), false), |e| (e.to_owned(), true))
}

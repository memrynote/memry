//! `resolveTagSchemas`, `descendantsOf` and `primaryObjectTag` of
//! `packages/app-core/src/tag-schema.ts`.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Map, Value};

use super::{
    DefinitionInput, InheritedFields, PRESET_KEYS, PropertyInfo, Relation, ResolvedField,
    ResolvedTag, ResolvedTemplate,
};
use crate::domain::tag_fields::is_reserved;
use crate::domain::tags::tag_key;

/// `name.trim().toLowerCase()`: how field names compare.
pub(super) fn fold(name: &str) -> String {
    name.trim().to_lowercase()
}

fn stored(def: Option<&DefinitionInput>) -> Option<&Map<String, Value>> {
    def?.schema.as_ref()?.readable()
}

fn relation_of(field: &Map<String, Value>) -> Option<Relation> {
    let relation = field.get("relation")?.as_object()?;
    Some(Relation {
        target: relation
            .get("target")
            .and_then(Value::as_str)
            .map(tag_key)
            .filter(|key| !key.is_empty()),
        many: relation.get("many") == Some(&Value::Bool(true)),
        inverse: relation
            .get("inverse")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn own_fields(
    key: &str,
    schema: Option<&Map<String, Value>>,
    types: &dyn Fn(&str) -> Option<PropertyInfo>,
) -> Vec<ResolvedField> {
    let mut seen = HashSet::new();
    let mut fields = Vec::new();
    let listed = schema
        .and_then(|s| s.get("fields"))
        .and_then(Value::as_array);
    for field in listed.into_iter().flatten().filter_map(Value::as_object) {
        let Some(name) = field.get("name").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if name.is_empty() || is_reserved(name) || !seen.insert(fold(name)) {
            continue;
        }
        let relation = relation_of(field);
        let definition = types(name);
        // A relation takes nothing from a definition of its name; any other field takes the
        // definition's options and calendar flag, even when its type is one a field cannot be
        // and the field reads as text.
        let (type_name, options, show_on_calendar) = match (&relation, &definition) {
            (Some(_), _) => ("relation".to_owned(), None, None),
            (None, None) => ("text".to_owned(), None, None),
            (None, Some(d)) => (
                match d.type_name.as_str() {
                    "project" | "relation" => "text".to_owned(),
                    other => other.to_owned(),
                },
                d.options.clone(),
                d.show_on_calendar,
            ),
        };
        fields.push(ResolvedField {
            name: name.to_owned(),
            type_name,
            options,
            show_on_calendar,
            relation,
            defined_by: key.to_owned(),
        });
    }
    fields
}

fn ancestors_of(key: &str, defs: &BTreeMap<String, DefinitionInput>) -> Vec<String> {
    let parent_of = |k: &str| {
        stored(defs.get(k))
            .and_then(|s| s.get("extends"))
            .and_then(Value::as_str)
            .map(tag_key)
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

fn own_preset(def: Option<&DefinitionInput>) -> Option<String> {
    stored(def)
        .and_then(|s| s.get("preset"))
        .and_then(Value::as_str)
        .filter(|p| PRESET_KEYS.contains(p))
        .map(str::to_owned)
}

fn template_of(schema: Option<&Map<String, Value>>) -> Option<(String, bool)> {
    let template = schema?.get("template")?.as_object()?;
    let id = template.get("id")?.as_str()?.to_owned();
    Some((id, template.get("autofill") == Some(&Value::Bool(true))))
}

/// One [`ResolvedTag`] per definition with a schema, readable or not.
pub fn resolve(
    defs: &BTreeMap<String, DefinitionInput>,
    types: &dyn Fn(&str) -> Option<PropertyInfo>,
) -> BTreeMap<String, ResolvedTag> {
    let mut own_cache: HashMap<String, Vec<ResolvedField>> = HashMap::new();
    let mut own = |key: &str| {
        own_cache
            .entry(key.to_owned())
            .or_insert_with(|| own_fields(key, stored(defs.get(key)), types))
            .clone()
    };

    let mut resolved = BTreeMap::new();
    for (key, def) in defs {
        let Some(schema) = &def.schema else {
            continue;
        };
        let ancestors = ancestors_of(key, defs);
        let own_fields = own(key);
        let mut listed: HashSet<String> = own_fields.iter().map(|f| fold(&f.name)).collect();
        let mut inherited = Vec::new();
        for ancestor in &ancestors {
            let fields: Vec<ResolvedField> = own(ancestor)
                .into_iter()
                .filter(|f| listed.insert(fold(&f.name)))
                .collect();
            if !fields.is_empty() {
                inherited.push(InheritedFields {
                    from: ancestor.clone(),
                    fields,
                });
            }
        }
        let effective_fields: Vec<ResolvedField> = inherited
            .iter()
            .rev()
            .flat_map(|group| group.fields.iter().cloned())
            .chain(own_fields.iter().cloned())
            .collect();
        let owners = || std::iter::once(key).chain(ancestors.iter());
        let template = owners().find_map(|owner| {
            let (id, autofill) = template_of(stored(defs.get(owner)))?;
            Some(ResolvedTemplate {
                id,
                autofill,
                inherited_from: (owner != key).then(|| owner.clone()),
            })
        });
        let extends = schema
            .readable()
            .and_then(|s| s.get("extends"))
            .and_then(Value::as_str)
            .map(tag_key)
            .filter(|k| !k.is_empty());
        resolved.insert(
            key.clone(),
            ResolvedTag {
                name: def.name.clone(),
                key: key.clone(),
                color: def.color.clone(),
                icon: def.icon.clone(),
                editable: schema.readable().is_some(),
                has_fields: !effective_fields.is_empty(),
                own_fields,
                inherited,
                effective_fields,
                extends,
                template,
                preset: owners().find_map(|owner| own_preset(defs.get(owner))),
                own_preset: own_preset(Some(def)),
                ancestors,
            },
        );
    }
    resolved
}

/// The keys of the tags whose chain of ancestors holds `tag` (`descendantsOf`).
pub fn descendants_of(tag: &str, resolved: &BTreeMap<String, ResolvedTag>) -> Vec<String> {
    let key = tag_key(tag);
    resolved
        .values()
        .filter(|entry| entry.ancestors.contains(&key))
        .map(|entry| entry.key.clone())
        .collect()
}

/// The first of `header_tags` with fields, own or inherited (`primaryObjectTag`).
pub fn primary_object_tag(
    header_tags: &[String],
    resolved: &BTreeMap<String, ResolvedTag>,
) -> Option<String> {
    header_tags
        .iter()
        .map(|tag| tag_key(tag))
        .find(|key| resolved.get(key).is_some_and(|t| t.has_fields))
}

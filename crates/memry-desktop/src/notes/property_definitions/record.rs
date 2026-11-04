//! A definition as the file holds it ([`PropertyDefinition`]) and as its synced record carries
//! it ([`DefinitionRecord`]): `rebuildSingleDbCache` and `definitionFromRow` of
//! `vault/property-definitions.ts`.
//!
//! The record's `options` is opaque to this build (§13.7.9): a newer build may put keys in an
//! option, in a status category, beside the categories, or add a category. The file holds none
//! of them, so a record written from the file takes them from the record it replaces: an
//! option keeps its keys by its value, a category by its key (#3844). An option this build
//! cannot read (no value or no color) is not in the file and leaves the record with the edit.

use memry_core::domain::property_admin::DEFAULT_STATUS_OPTIONS;
use memry_core::domain::property_admin::records::DefinitionRecord;
use serde_json::{Map, Value, json};

use crate::vault::properties_file::{
    PropertyDefinition, PropertyKind, SelectOption, StatusCategories, StatusCategory,
};

/// `options` as JSON, each option on the object of the `prior` option with its value.
fn options_json(options: &[SelectOption], prior: Option<&Value>) -> Value {
    let mut unused: Vec<&Map<String, Value>> = prior
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    Value::Array(
        options
            .iter()
            .map(|option| {
                let held = unused.iter().position(|held| {
                    held.get("value").and_then(Value::as_str) == Some(&option.value)
                });
                let mut entry = held.map(|at| unused.remove(at).clone()).unwrap_or_default();
                entry.insert("value".into(), json!(option.value));
                entry.insert("color".into(), json!(option.color));
                match option.default {
                    Some(flag) => drop(entry.insert("default".into(), json!(flag))),
                    None => drop(entry.shift_remove("default")),
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

/// A status's `options`: the `prior` object with its categories, each category on its prior
/// object.
fn categories_json(categories: &StatusCategories, prior: Option<&Value>) -> Value {
    let mut whole = prior
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut all = whole
        .get("categories")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, category) in [
        ("todo", &categories.todo),
        ("in_progress", &categories.in_progress),
        ("done", &categories.done),
    ] {
        let mut entry = all
            .get(key)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let options = options_json(&category.options, entry.get("options"));
        entry.insert("label".into(), json!(category.label));
        entry.insert("options".into(), options);
        all.insert(key.into(), Value::Object(entry));
    }
    whole.insert("categories".into(), Value::Object(all));
    Value::Object(whole)
}

/// The record's `options` text: the categories of a status, no text for a date or a project,
/// the option list of every other type; what `prior` holds that this build does not read kept.
fn options_over(kind: &PropertyKind, prior: Option<&Value>) -> Option<String> {
    let value = match kind {
        PropertyKind::Text(options)
        | PropertyKind::Number(options)
        | PropertyKind::Checkbox(options)
        | PropertyKind::Url(options)
        | PropertyKind::Select(options)
        | PropertyKind::Multiselect(options) => options_json(options, prior),
        PropertyKind::Status(categories) => categories_json(categories, prior),
        PropertyKind::Date { .. } | PropertyKind::Project => return None,
    };
    Some(value.to_string())
}

/// The `options` text a definition alone gives.
pub(super) fn options_text(kind: &PropertyKind) -> Option<String> {
    options_over(kind, None)
}

/// The record `definition` mirrors, over the record it replaces. The calendar flag of a date
/// stays in this device's file.
pub(super) fn record_of(
    name: &str,
    definition: &PropertyDefinition,
    prior: Option<&DefinitionRecord>,
) -> DefinitionRecord {
    let prior = prior
        .and_then(|prior| prior.options.as_deref())
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    DefinitionRecord {
        name: name.to_owned(),
        type_name: definition.kind.type_name().to_owned(),
        options: options_over(&definition.kind, prior.as_ref()),
        default_value: definition.default_value.clone(),
        color: definition.color.clone(),
    }
}

/// An option a file would read back: a value and a color, both non-empty.
fn option_of(value: &Value) -> Option<SelectOption> {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Some(SelectOption {
        value: text("value")?,
        color: text("color")?,
        default: value.get("default").and_then(Value::as_bool),
    })
}

fn options_of(value: Option<&Value>) -> Vec<SelectOption> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(option_of).collect())
        .unwrap_or_default()
}

fn categories_of(options: &Value) -> Option<StatusCategories> {
    let categories = options.get("categories")?;
    let category = |key: &str| {
        let category = categories.get(key)?;
        Some(StatusCategory {
            label: category
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.is_empty())?
                .to_owned(),
            options: options_of(category.get("options")),
        })
    };
    Some(StatusCategories {
        todo: category("todo")?,
        in_progress: category("in_progress")?,
        done: category("done")?,
    })
}

/// `DEFAULT_STATUS_CATEGORIES` of `@memry/contracts`, as the core spells it.
pub(super) fn default_categories() -> StatusCategories {
    let options = serde_json::from_str(DEFAULT_STATUS_OPTIONS).expect("the default parses");
    categories_of(&options).expect("the default has every category")
}

/// The definition a record holds, or `None` for a type no file holds (`relation`, or one this
/// build does not know). Options that do not parse read as none, and a status without its
/// categories as the default ones, as Electron reads a row.
pub(super) fn definition_of(record: &DefinitionRecord) -> Option<PropertyDefinition> {
    let options: Value = match record.options.as_deref().map(serde_json::from_str) {
        Some(Ok(value)) => value,
        Some(Err(error)) => {
            tracing::warn!(scope = "PropertyDefinitions", name = %record.name, "a synced property definition's options do not parse; ignoring them: {error}");
            Value::Null
        }
        None => Value::Null,
    };
    let list = || options_of(Some(&options));
    let kind = match record.type_name.as_str() {
        "text" => PropertyKind::Text(list()),
        "number" => PropertyKind::Number(list()),
        "checkbox" => PropertyKind::Checkbox(list()),
        "url" => PropertyKind::Url(list()),
        "select" => PropertyKind::Select(list()),
        "multiselect" => PropertyKind::Multiselect(list()),
        "status" => {
            PropertyKind::Status(categories_of(&options).unwrap_or_else(default_categories))
        }
        "date" => PropertyKind::Date {
            show_on_calendar: false,
        },
        "project" => PropertyKind::Project,
        _ => return None,
    };
    let filled = |field: &Option<String>| field.clone().filter(|text| !text.is_empty());
    Some(PropertyDefinition {
        kind,
        default_value: filled(&record.default_value),
        color: filled(&record.color),
    })
}

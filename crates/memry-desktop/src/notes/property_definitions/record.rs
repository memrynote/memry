//! A definition as the file holds it ([`PropertyDefinition`]) and as its synced record carries
//! it ([`DefinitionRecord`]): `rebuildSingleDbCache` and `definitionFromRow` of
//! `vault/property-definitions.ts`.

use memry_core::domain::property_admin::DEFAULT_STATUS_OPTIONS;
use memry_core::domain::property_admin::records::DefinitionRecord;
use serde_json::{Map, Value, json};

use crate::vault::properties_file::{
    PropertyDefinition, PropertyKind, SelectOption, StatusCategories, StatusCategory,
};

fn options_json(options: &[SelectOption]) -> Value {
    Value::Array(
        options
            .iter()
            .map(|option| {
                let mut entry = Map::new();
                entry.insert("value".into(), json!(option.value));
                entry.insert("color".into(), json!(option.color));
                if let Some(flag) = option.default {
                    entry.insert("default".into(), json!(flag));
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

fn category_json(category: &StatusCategory) -> Value {
    json!({ "label": category.label, "options": options_json(&category.options) })
}

/// The record's `options` text: the categories of a status, no text for a date or a project,
/// the option list of every other type.
pub(super) fn options_text(kind: &PropertyKind) -> Option<String> {
    let value = match kind {
        PropertyKind::Text(options)
        | PropertyKind::Number(options)
        | PropertyKind::Checkbox(options)
        | PropertyKind::Url(options)
        | PropertyKind::Select(options)
        | PropertyKind::Multiselect(options) => options_json(options),
        PropertyKind::Status(categories) => json!({ "categories": {
            "todo": category_json(&categories.todo),
            "in_progress": category_json(&categories.in_progress),
            "done": category_json(&categories.done),
        }}),
        PropertyKind::Date { .. } | PropertyKind::Project => return None,
    };
    Some(value.to_string())
}

/// The record `definition` mirrors. The calendar flag of a date stays in this device's file.
pub(super) fn record_of(name: &str, definition: &PropertyDefinition) -> DefinitionRecord {
    DefinitionRecord {
        name: name.to_owned(),
        type_name: definition.kind.type_name().to_owned(),
        options: options_text(&definition.kind),
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

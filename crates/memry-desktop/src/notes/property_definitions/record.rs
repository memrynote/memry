//! A definition as the file holds it ([`PropertyDefinition`]) and as its synced record carries
//! it ([`DefinitionRecord`]): `rebuildSingleDbCache` and `definitionFromRow` of
//! `vault/property-definitions.ts`.
//!
//! The record's `options` is opaque to this build (§13.7.9): a newer build may put keys in an
//! option, in a status category, beside the categories, or add a category. The file holds none
//! of them, so a record written from the file takes them from the record it replaces: an
//! option keeps its keys by its value (a renamed one by its place before the rename), a
//! category by its key (#3844). An option this build
//! cannot read (no value or no color) is not in the file and leaves the record with the edit.

use memry_core::domain::property_admin::DEFAULT_STATUS_OPTIONS;
use memry_core::domain::property_admin::records::DefinitionRecord;
use serde_json::{Map, Value, json};

use crate::vault::properties_file::{
    PropertyDefinition, PropertyKind, SelectOption, StatusCategories, StatusCategory,
};

/// A rename of an option by the edit: the old value and the definition's kind before the edit,
/// whose option lists the rename kept in order.
pub(super) type Renamed<'a> = Option<(&'a str, &'a PropertyKind)>;

/// `options` as JSON, each option on the object of the `prior` option with its value: with the
/// old value for an option `renamed` (the old value, and the list before the edit) renamed.
fn options_json(
    options: &[SelectOption],
    prior: Option<&Value>,
    renamed: Option<(&str, &[SelectOption])>,
) -> Value {
    let mut unused: Vec<&Map<String, Value>> = prior
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    Value::Array(
        options
            .iter()
            .enumerate()
            .map(|(at, option)| {
                let was = match renamed {
                    Some((old, before)) if before.get(at).is_some_and(|b| b.value == old) => old,
                    _ => option.value.as_str(),
                };
                let held = unused
                    .iter()
                    .position(|held| held.get("value").and_then(Value::as_str) == Some(was));
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
fn categories_json(
    categories: &StatusCategories,
    prior: Option<&Value>,
    renamed: Option<(&str, &StatusCategories)>,
) -> Value {
    let mut whole = prior
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut all = whole
        .get("categories")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let before = renamed.map(|(old, b)| (old, [&b.todo, &b.in_progress, &b.done]));
    for (at, (key, category)) in [
        ("todo", &categories.todo),
        ("in_progress", &categories.in_progress),
        ("done", &categories.done),
    ]
    .into_iter()
    .enumerate()
    {
        let mut entry = all
            .get(key)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let renamed = before.map(|(old, lists)| (old, lists[at].options.as_slice()));
        let options = options_json(&category.options, entry.get("options"), renamed);
        entry.insert("label".into(), json!(category.label));
        entry.insert("options".into(), options);
        all.insert(key.into(), Value::Object(entry));
    }
    whole.insert("categories".into(), Value::Object(all));
    Value::Object(whole)
}

fn list_of(kind: &PropertyKind) -> Option<&[SelectOption]> {
    match kind {
        PropertyKind::Text(options)
        | PropertyKind::Number(options)
        | PropertyKind::Checkbox(options)
        | PropertyKind::Url(options)
        | PropertyKind::Select(options)
        | PropertyKind::Multiselect(options) => Some(options),
        PropertyKind::Status(_) | PropertyKind::Date { .. } | PropertyKind::Project => None,
    }
}

/// The record's `options` text: the categories of a status, no text for a date or a project,
/// the option list of every other type; what `prior` holds that this build does not read kept.
fn options_over(
    kind: &PropertyKind,
    prior: Option<&Value>,
    renamed: Renamed<'_>,
) -> Option<String> {
    let value = match kind {
        PropertyKind::Text(options)
        | PropertyKind::Number(options)
        | PropertyKind::Checkbox(options)
        | PropertyKind::Url(options)
        | PropertyKind::Select(options)
        | PropertyKind::Multiselect(options) => {
            let before = renamed.and_then(|(old, before)| Some((old, list_of(before)?)));
            options_json(options, prior, before)
        }
        PropertyKind::Status(categories) => {
            let before = renamed.and_then(|(old, before)| match before {
                PropertyKind::Status(before) => Some((old, before)),
                _ => None,
            });
            categories_json(categories, prior, before)
        }
        PropertyKind::Date { .. } | PropertyKind::Project => return None,
    };
    Some(value.to_string())
}

/// The `options` text a definition alone gives.
pub(super) fn options_text(kind: &PropertyKind) -> Option<String> {
    options_over(kind, None, None)
}

/// The record `definition` mirrors, over the record it replaces and `before`, the kind it
/// replaces. The calendar flag of a date stays in this device's file. A `project` holds no
/// options the file keeps, so its record keeps the ones it held, or those of the type it
/// replaces (Electron's learner passes `existing?.options`, #4025).
pub(super) fn record_of(
    name: &str,
    definition: &PropertyDefinition,
    prior: Option<&DefinitionRecord>,
    before: Option<&PropertyKind>,
    renamed: Renamed<'_>,
) -> DefinitionRecord {
    let held = prior.and_then(|prior| prior.options.clone());
    let prior = held
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let options = match (&definition.kind, before) {
        (PropertyKind::Project, Some(PropertyKind::Project) | None) => held,
        (PropertyKind::Project, Some(before)) => options_over(before, prior.as_ref(), None),
        (kind, _) => options_over(kind, prior.as_ref(), renamed),
    };
    DefinitionRecord {
        name: name.to_owned(),
        type_name: definition.kind.type_name().to_owned(),
        options,
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

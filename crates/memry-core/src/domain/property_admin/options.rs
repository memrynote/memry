//! The option-list shapes a `property_definition` carries: a flat array, or
//! status categories each holding an array.

use serde_json::Value;

use super::PropertyOption;

/// The options as `(category, entries)` groups, in stored order.
fn groups(options: &Value) -> Vec<(Option<String>, Vec<Value>)> {
    if let Some(array) = options.as_array() {
        return vec![(None, array.clone())];
    }
    options
        .get("categories")
        .and_then(Value::as_object)
        .map(|categories| {
            categories
                .iter()
                .map(|(key, category)| {
                    (
                        Some(key.clone()),
                        category
                            .get("options")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn flatten(options: &Value) -> Vec<PropertyOption> {
    groups(options)
        .into_iter()
        .flat_map(|(category, entries)| {
            entries.into_iter().filter_map(move |entry| {
                Some(PropertyOption {
                    value: entry.get("value")?.as_str()?.to_owned(),
                    color: entry
                        .get("color")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    category: category.clone(),
                })
            })
        })
        .collect()
}

/// Applies `change` to every option array in `options`.
pub(super) fn map_arrays(
    options: &mut Value,
    mut change: impl FnMut(Option<&str>, &mut Vec<Value>),
) {
    if let Some(array) = options.as_array_mut() {
        change(None, array);
        return;
    }
    if let Some(categories) = options.get_mut("categories").and_then(Value::as_object_mut) {
        for (key, category) in categories.iter_mut() {
            if let Some(array) = category.get_mut("options").and_then(Value::as_array_mut) {
                change(Some(key), array);
            }
        }
    }
}

pub(super) fn is_value(entry: &Value, value: &str) -> bool {
    entry.get("value").and_then(Value::as_str) == Some(value)
}

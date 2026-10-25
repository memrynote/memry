//! `getSchemaProperty`: a dotted-path search through JSON-LD that falls back to a deep search.

use crate::web::extract::utils::json::JsValue;

/// `data.hasOwnProperty(...)` threw: the JSON-LD object has an own `hasOwnProperty` key, which
/// shadows the method. `getSchemaProperty` catches the `TypeError` and returns its default.
struct ShadowedHasOwnProperty;

fn same_value_zero(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Number(x), JsValue::Number(y)) => x == y,
        (JsValue::Array(_) | JsValue::Object(_), _)
        | (_, JsValue::Array(_) | JsValue::Object(_)) => false,
        _ => a == b,
    }
}

/// `/^\[\d+\]$/` then `parseInt(prop.slice(1, -1))`.
fn bracket_index(prop: &str) -> Option<usize> {
    let inner = prop.strip_prefix('[')?.strip_suffix(']')?;
    if inner.is_empty() || !inner.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    inner.parse().ok()
}

/// `searchSchema(data, props, fullPath, isExactMatch)`.
fn search(
    data: &JsValue,
    props: &[&str],
    exact: bool,
) -> Result<Vec<JsValue>, ShadowedHasOwnProperty> {
    match data {
        JsValue::String(s) => {
            return Ok(if props.is_empty() {
                vec![JsValue::String(s.clone())]
            } else {
                vec![]
            });
        }
        JsValue::Array(items) => {
            if let Some(&current) = props.first()
                && let Some(index) = bracket_index(current)
            {
                return match items.get(index) {
                    Some(item) if item.truthy() => search(item, &props[1..], exact),
                    _ => Ok(vec![]),
                };
            }
            if props.is_empty()
                && items
                    .iter()
                    .all(|i| matches!(i, JsValue::String(_) | JsValue::Number(_)))
            {
                return Ok(items
                    .iter()
                    .map(|i| JsValue::String(i.to_js_string()))
                    .collect());
            }
            let mut out = Vec::new();
            for item in items {
                out.extend(search(item, props, exact)?);
            }
            return Ok(out);
        }
        JsValue::Object(_) => {}
        _ => return Ok(vec![]),
    }
    let Some((&current, remaining)) = props.split_first().filter(|(p, _)| !p.is_empty()) else {
        return Ok(match data.get("name") {
            Some(name) if name.truthy() => vec![name.clone()],
            _ => vec![],
        });
    };
    if data.get("hasOwnProperty").is_some() {
        return Err(ShadowedHasOwnProperty);
    }
    if let Some(value) = data.get(current) {
        return search(value, remaining, true);
    }
    if !exact && let JsValue::Object(entries) = data {
        let mut nested = Vec::new();
        for (_, value) in entries {
            if value.is_object_like() || *value == JsValue::Null {
                nested.extend(search(value, props, false)?);
            }
        }
        if !nested.is_empty() {
            return Ok(nested);
        }
    }
    Ok(vec![])
}

/// `getSchemaProperty(schemaOrgData, property)` with the default `''`: the distinct truthy
/// matches joined with `", "`.
pub fn get_schema_property(schema_org_data: &JsValue, property: &str) -> String {
    let props: Vec<&str> = property.split('.').collect();
    let run = || -> Result<Vec<JsValue>, ShadowedHasOwnProperty> {
        let mut results = search(schema_org_data, &props, true)?;
        if results.is_empty() {
            results = search(schema_org_data, &props, false)?;
        }
        Ok(results)
    };
    let Ok(results) = run() else {
        return String::new();
    };
    let mut unique: Vec<JsValue> = Vec::new();
    for value in results.into_iter().filter(JsValue::truthy) {
        if !unique.iter().any(|seen| same_value_zero(seen, &value)) {
            unique.push(value);
        }
    }
    unique
        .iter()
        .map(JsValue::to_js_string)
        .collect::<Vec<_>>()
        .join(", ")
}

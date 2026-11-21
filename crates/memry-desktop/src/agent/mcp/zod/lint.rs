//! The schemas the walk reads, refused up front when it would misread them.

use serde_json::Value;

use super::regex;
use super::resolve_ref;
use super::union::discriminator;

const KEYWORDS: &[&str] = &[
    "type",
    "properties",
    "required",
    "additionalProperties",
    "propertyNames",
    "items",
    "additionalItems",
    "prefixItems",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "$ref",
    "$defs",
    "default",
    "description",
    "$schema",
];

/// Refuses a schema the walk would misread: an unknown keyword, a pattern `regex` cannot build,
/// a format other than zod's `date-time` (which zod prints with its pattern), a `$ref` that
/// does not resolve, or a `oneOf` without a discriminator.
pub(in crate::agent::mcp) fn lint(root: &Value) -> Result<(), String> {
    lint_node(root, root, "#")
}

fn lint_node(root: &Value, node: &Value, at: &str) -> Result<(), String> {
    let Some(schema) = node.as_object() else {
        return Err(format!("{at}: a schema is an object"));
    };
    for (key, child) in schema {
        let at = format!("{at}/{key}");
        if !KEYWORDS.contains(&key.as_str()) {
            return Err(format!("{at}: unknown keyword"));
        }
        let checked = match key.as_str() {
            "pattern" if regex(child.as_str().unwrap_or_default()).is_none() => {
                Err("the pattern does not build")
            }
            "format" if child != "date-time" || !schema.contains_key("pattern") => {
                Err("only date-time with its pattern")
            }
            "$ref" if resolve_ref(root, child.as_str().unwrap_or_default()).is_none() => {
                Err("unresolved")
            }
            "oneOf" if discriminator(child.as_array().map_or(&[][..], Vec::as_slice)).is_none() => {
                Err("no discriminator")
            }
            "propertyNames" if child.get("enum").is_some() => Err("an enum-keyed record"),
            _ => Ok(()),
        };
        checked.map_err(|problem| format!("{at}: {problem}"))?;
        match key.as_str() {
            "properties" | "$defs" => {
                for (name, child) in child.as_object().into_iter().flatten() {
                    lint_node(root, child, &format!("{at}/{name}"))?;
                }
            }
            "anyOf" | "oneOf" | "prefixItems" => {
                for (index, child) in child.as_array().into_iter().flatten().enumerate() {
                    lint_node(root, child, &format!("{at}/{index}"))?;
                }
            }
            "items" if child.is_array() => {
                for (index, child) in child.as_array().into_iter().flatten().enumerate() {
                    lint_node(root, child, &format!("{at}/{index}"))?;
                }
            }
            "items" | "additionalItems" | "propertyNames" => lint_node(root, child, &at)?,
            "additionalProperties" if child.is_object() => lint_node(root, child, &at)?,
            _ => {}
        }
    }
    Ok(())
}

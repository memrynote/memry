//! The text of a `.excalidraw` canvas file and of the shapes library, as
//! Electron writes them (`apps/desktop/src/main/canvas/scene-file.ts`
//! `withCanvasMeta`, `stripCanvasMeta`, `readCanvasMeta`, and
//! `library-file.ts` `writeCanvasLibrary`). Both apps share one vault, so the
//! bytes are a shipped format: the fixtures in `file_format/` are Electron's own
//! output and these functions reproduce them byte for byte.
//!
//! `JSON.parse` and `JSON.stringify` are reproduced, not approximated: object
//! keys keep JavaScript's order (array-index keys first, ascending), `-0`
//! prints `0`, and numbers print the way `Number#toString` does.

use serde_json::{Map, Value};

use crate::markdown::frontmatter::js::number_to_string;
use crate::markdown::shared::block_colors::js_value::{js_parse, order_keys};

/// The top-level key of Electron's sidecar inside a canvas file.
const FILE_META_KEY: &str = "memry";

/// Electron's `CanvasFileMeta`: the sidecar that makes one copied file
/// self-describing. Instants are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMeta {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `withCanvasMeta`: the file text of `scene` with `meta` embedded, pretty
/// printed with two spaces. A blank or unparseable scene is written as an
/// empty board, as Electron does; callers that must not lose ink refuse such a
/// scene first (`canonical_scene`).
pub fn with_file_meta(scene: &str, meta: &FileMeta) -> String {
    let parsed = if scene.trim().is_empty() {
        None
    } else {
        js_parse(scene)
    };
    let mut out = String::new();
    write_pretty(&canonicalize(parsed, Some(meta)), 0, &mut out);
    out
}

/// `stripCanvasMeta`: the scene as sync and comparison see it, the sidecar
/// removed and printed compact. Blank text is `""`; text that is not JSON comes
/// back unchanged.
pub fn strip_file_meta(content: &str) -> String {
    if content.trim().is_empty() {
        return String::new();
    }
    match js_parse(content) {
        Some(parsed) => {
            let mut out = String::new();
            write_compact(&canonicalize(Some(parsed), None), &mut out);
            out
        }
        None => content.to_owned(),
    }
}

/// `readCanvasMeta`: the sidecar, or `None` when the text is not JSON or has
/// no non-empty string id. A missing or non-numeric instant reads as `now_ms`.
pub fn read_file_meta(content: &str, now_ms: i64) -> Option<FileMeta> {
    let parsed: Value = serde_json::from_str(content).ok()?;
    let meta = parsed.get(FILE_META_KEY)?;
    let id = meta.get("id")?.as_str().filter(|id| !id.is_empty())?;
    let instant = |key: &str| {
        meta.get(key)
            .and_then(Value::as_f64)
            .map_or(now_ms, |ms| ms as i64)
    };
    Some(FileMeta {
        id: id.to_owned(),
        created_at: instant("createdAt"),
        updated_at: instant("updatedAt"),
    })
}

/// `writeCanvasLibrary`'s file text: the standard `excalidrawlib` document
/// around `items`, pretty printed. Keys keep JavaScript's order.
pub fn library_text(items: &[Value]) -> String {
    let mut items = Value::Array(items.to_vec());
    js_key_order(&mut items);
    let mut document = Map::new();
    document.insert("type".into(), Value::from("excalidrawlib"));
    document.insert("version".into(), Value::from(2));
    document.insert("source".into(), Value::from("memry"));
    document.insert("libraryItems".into(), items);
    let mut out = String::new();
    write_pretty(&Value::Object(document), 0, &mut out);
    out
}

/// The `libraryItems` of a library file's text: `None` when the text is not
/// JSON, an empty list when it holds no item array (`readCanvasLibrary`).
pub fn library_items(content: &str) -> Option<Vec<Value>> {
    match js_parse(content)? {
        Value::Object(mut document) => match document.remove("libraryItems") {
            Some(Value::Array(items)) => Some(items),
            _ => Some(Vec::new()),
        },
        _ => Some(Vec::new()),
    }
}

/// The key order a JavaScript object of these keys has, at every depth.
fn js_key_order(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.values_mut().for_each(js_key_order);
            order_keys(map);
        }
        Value::Array(items) => items.iter_mut().for_each(js_key_order),
        _ => {}
    }
}

/// `canonicalize(parsed, meta)`: the head keys in order, each defaulted when
/// `null` or absent (`??`), the sidecar after `source` when given, then every
/// other key sorted by UTF-16 code unit. A parsed value that is not an object
/// destructures to nothing, as in JavaScript; `null` (which JavaScript cannot
/// destructure) is the empty board.
fn canonicalize(parsed: Option<Value>, meta: Option<&FileMeta>) -> Value {
    let mut parsed = match parsed {
        Some(Value::Object(map)) => map,
        Some(Value::Array(items)) => items
            .into_iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item))
            .collect(),
        _ => Map::new(),
    };
    let mut take = |key: &str, default: Value| {
        parsed
            .remove(key)
            .filter(|value| !value.is_null())
            .unwrap_or(default)
    };
    let mut out = Map::new();
    out.insert("type".into(), take("type", Value::from("excalidraw")));
    out.insert("version".into(), take("version", Value::from(2)));
    out.insert("source".into(), take("source", Value::from("memry")));
    if let Some(meta) = meta {
        let mut sidecar = Map::new();
        sidecar.insert("id".into(), Value::from(meta.id.as_str()));
        sidecar.insert("createdAt".into(), Value::from(meta.created_at));
        sidecar.insert("updatedAt".into(), Value::from(meta.updated_at));
        out.insert(FILE_META_KEY.into(), Value::Object(sidecar));
    }
    out.insert(
        "elements".into(),
        take("elements", Value::Array(Vec::new())),
    );
    out.insert(
        "appState".into(),
        take("appState", Value::Object(Map::new())),
    );
    out.insert("files".into(), take("files", Value::Object(Map::new())));
    parsed.remove(FILE_META_KEY);
    let mut rest: Vec<(String, Value)> = parsed.into_iter().collect();
    rest.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    out.extend(rest);
    // An array-index key such as "0" goes first in JavaScript whatever the
    // insertion order.
    order_keys(&mut out);
    Value::Object(out)
}

fn write_compact(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_compact(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_compact(item, out);
            }
            out.push('}');
        }
        scalar => write_scalar(scalar, out),
    }
}

fn write_pretty(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(depth + 1, out);
                write_pretty(item, depth + 1, out);
            }
            newline(depth, out);
            out.push(']');
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(depth + 1, out);
                write_string(key, out);
                out.push_str(": ");
                write_pretty(item, depth + 1, out);
            }
            newline(depth, out);
            out.push('}');
        }
        other => write_compact(other, out),
    }
}

fn newline(depth: usize, out: &mut String) {
    out.push('\n');
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn write_scalar(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => match number.as_f64() {
            Some(x) if x.is_finite() => out.push_str(&number_to_string(x)),
            _ => out.push_str("null"),
        },
        Value::String(text) => write_string(text, out),
        Value::Array(_) | Value::Object(_) => unreachable!("containers are written by the caller"),
    }
}

/// `JSON.stringify` of a string: `"` and `\` escaped, the five short control
/// escapes, every other control character as `\u00xx` in lower-case hex.
/// serde_json escapes exactly that set.
fn write_string(text: &str, out: &mut String) {
    out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned()));
}

#[cfg(test)]
mod tests;

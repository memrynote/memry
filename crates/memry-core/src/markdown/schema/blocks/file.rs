//! The file block of `blocks/markdown.ts`: an HTML comment carrying the props
//! as JSON.

use serde_json::Value;

use crate::markdown::frontmatter::js::number_to_string;

const FILE_PREFIX: &str = "<!-- file:";
const FILE_SUFFIX: &str = " -->";

/// `FileBlockProps`. `width`/`height` of `0` or less, `align` of `left` and any
/// `display` but `link` are omitted from the marker so legacy markers stay
/// byte-identical.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FileBlockProps {
    pub url: String,
    pub name: String,
    pub size: f64,
    pub mime_type: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub align: Option<String>,
    pub display: Option<String>,
}

/// `^<!-- file:\{[^}]+\} -->$`: the JSON object text between `file:` and the
/// closing ` -->`, braces included. The payload holds no `}` but the last.
fn file_marker_payload(line: &str) -> Option<&str> {
    let json = line.strip_prefix(FILE_PREFIX)?.strip_suffix(FILE_SUFFIX)?;
    let inner = json.strip_prefix('{')?.strip_suffix('}')?;
    (!inner.is_empty() && !inner.contains('}')).then_some(json)
}

/// `FILE_BLOCK_LINE_REGEX`: a whole line that is nothing but a file marker.
pub fn is_file_block_line(line: &str) -> bool {
    file_marker_payload(line).is_some()
}

/// `parseFileBlockMarker`: the props object of one already-trimmed marker line,
/// or `None` when the line is not a marker or its JSON does not parse. A
/// `display` other than `link` is dropped.
pub fn parse_file_block_marker(marker: &str) -> Option<Value> {
    let json = file_marker_payload(marker)?;
    let mut props: Value = serde_json::from_str(json).ok()?;
    if let Some(map) = props.as_object_mut()
        && map.get("display").and_then(Value::as_str) != Some("link")
    {
        map.shift_remove("display");
    }
    Some(props)
}

/// `JSON.stringify` of a number.
fn json_number(n: f64) -> String {
    if n.is_finite() {
        number_to_string(n)
    } else {
        "null".to_owned()
    }
}

fn json_string(text: &str) -> String {
    // serde_json escapes the same set as `JSON.stringify`: the quote, the
    // backslash and the control characters (`\b \f \n \r \t`, else `\u00xx`).
    Value::String(text.to_owned()).to_string()
}

/// `escapeCommentTerminator`: `--(!?)>` becomes `--$1\u003e`, so a comment end
/// anywhere in the payload cannot close the marker early.
fn escape_comment_terminator(json: &str) -> String {
    let bytes = json.as_bytes();
    let mut out = String::with_capacity(json.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"--") {
            let mut j = i + 2;
            if bytes.get(j) == Some(&b'!') {
                j += 1;
            }
            if bytes.get(j) == Some(&b'>') {
                out.push_str(&json[copied..j]);
                out.push_str("\\u003e");
                copied = j + 1;
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&json[copied..]);
    out
}

/// `fileBlockCommentData`: everything between `<!--` and `-->`, spaces
/// included. Keys are written in a fixed order.
pub fn file_block_comment_data(props: &FileBlockProps) -> String {
    let mut fields = vec![
        format!("\"url\":{}", json_string(&props.url)),
        format!("\"name\":{}", json_string(&props.name)),
        format!("\"size\":{}", json_number(props.size)),
        format!("\"mimeType\":{}", json_string(&props.mime_type)),
    ];
    if let Some(width) = props.width.filter(|w| *w > 0.0) {
        fields.push(format!("\"width\":{}", json_number(width)));
    }
    if let Some(height) = props.height.filter(|h| *h > 0.0) {
        fields.push(format!("\"height\":{}", json_number(height)));
    }
    if let Some(align) = props
        .align
        .as_deref()
        .filter(|a| !a.is_empty() && *a != "left")
    {
        fields.push(format!("\"align\":{}", json_string(align)));
    }
    if props.display.as_deref() == Some("link") {
        fields.push("\"display\":\"link\"".to_owned());
    }
    let json = format!("{{{}}}", fields.join(","));
    format!(" file:{} ", escape_comment_terminator(&json))
}

/// `serializeFileBlock`.
pub fn serialize_file_block(props: &FileBlockProps) -> String {
    format!("<!--{}-->", file_block_comment_data(props))
}

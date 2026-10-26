//! Inline content to DOM: BlockNote's `inlineContentToNodes` and
//! `serializeInlineContentExternalHTML`, with the memry inline specs.
//!
//! A text run's marks wrap it in schema rank order, outermost first. A top
//! level block serializes each node on its own; a table cell goes through
//! ProseMirror's `DOMSerializer.serializeFragment`, which keeps one wrapper
//! open across neighbours that share the leading marks (see [`pm_fragment`]).

use serde_json::Value as Json;

use super::{err, table, truthy};
use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::bn::dom_parser::rules::js::{js_number, js_round};
use crate::markdown::convert::ConvertError;
use crate::markdown::shared::critic_markup::uri::encode_uri_component;
use crate::markdown::shared::html_comments::encode_html_comment_token;

/// A ProseMirror mark of the memry schema: its rank in `schema.marks` and its
/// one attribute (`stringValue` of a colour, `href` of a link).
#[derive(Clone, PartialEq, Debug)]
pub(super) struct Mark {
    rank: u8,
    value: String,
}

const LINK_RANK: u8 = 7;

#[derive(Debug)]
pub(super) enum Inl {
    Text { text: String, marks: Vec<Mark> },
    Break,
    Custom { ty: String, props: Json },
}

/// `[rank, string-valued]` of a BlockNote style, by name.
fn style_config(name: &str) -> Option<(u8, bool)> {
    Some(match name {
        "bold" => (0, false),
        "italic" => (1, false),
        "underline" => (2, false),
        "strike" => (3, false),
        "code" => (4, false),
        "textColor" => (5, true),
        "backgroundColor" => (6, true),
        _ => return None,
    })
}

fn is_plain(block_type: Option<&str>) -> bool {
    matches!(block_type, Some("codeBlock" | "diagram"))
}

fn js_string(value: &Json) -> String {
    match value {
        Json::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `styledTextToNodes`.
fn styled_text_nodes(item: &Json, block_type: Option<&str>) -> Result<Vec<Inl>, ConvertError> {
    let text = item.get("text").and_then(Json::as_str).unwrap_or("");
    let mut marks = Vec::new();
    if let Some(styles) = item.get("styles").and_then(Json::as_object) {
        for (name, value) in styles {
            let (rank, string_valued) =
                style_config(name).ok_or_else(|| err(format!("style {name} not found")))?;
            if truthy(Some(value)) {
                marks.push(Mark {
                    rank,
                    value: if string_valued {
                        js_string(value)
                    } else {
                        String::new()
                    },
                });
            }
        }
    }
    if is_plain(block_type) {
        return Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![Inl::Text {
                text: text.to_owned(),
                marks: Vec::new(),
            }]
        });
    }
    marks.sort_by_key(|m| m.rank);
    let mut nodes = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if c == '\n' {
            if !current.is_empty() {
                nodes.push(Inl::Text {
                    text: std::mem::take(&mut current),
                    marks: marks.clone(),
                });
            }
            nodes.push(Inl::Break);
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() {
        nodes.push(Inl::Text {
            text: current,
            marks,
        });
    }
    Ok(nodes)
}

/// `styledTextArrayToNodes`: a string, or an array of styled texts and strings.
fn styled_array_nodes(content: &Json, block_type: Option<&str>) -> Result<Vec<Inl>, ConvertError> {
    let plain = |s: &str| json_styled(s);
    match content {
        Json::String(s) => styled_text_nodes(&plain(s), block_type),
        Json::Array(items) => {
            let mut nodes = Vec::new();
            for item in items {
                let styled = match item {
                    Json::String(s) => plain(s),
                    other => other.clone(),
                };
                nodes.extend(styled_text_nodes(&styled, block_type)?);
            }
            Ok(nodes)
        }
        _ => Ok(Vec::new()),
    }
}

fn json_styled(text: &str) -> Json {
    serde_json::json!({"type": "text", "text": text, "styles": {}})
}

/// `inlineContentToNodes`.
pub(super) fn inline_content_nodes(
    content: &Json,
    block_type: Option<&str>,
) -> Result<Vec<Inl>, ConvertError> {
    let items: Vec<Json> = match content {
        Json::String(s) => vec![Json::String(s.clone())],
        Json::Array(items) => items.clone(),
        _ => return Err(err("inline content is neither a string nor an array")),
    };
    let mut nodes = Vec::new();
    for item in &items {
        match item {
            Json::String(s) => nodes.extend(styled_text_nodes(&json_styled(s), block_type)?),
            Json::Object(_) => match item.get("type").and_then(Json::as_str) {
                Some("link") => {
                    let href = item.get("href").map(js_string).unwrap_or_default();
                    let inner = item.get("content").cloned().unwrap_or(Json::Null);
                    for node in styled_array_nodes(&inner, None)? {
                        nodes.push(match node {
                            Inl::Text { text, mut marks } => {
                                marks.push(Mark {
                                    rank: LINK_RANK,
                                    value: href.clone(),
                                });
                                marks.sort_by_key(|m| m.rank);
                                Inl::Text { text, marks }
                            }
                            other @ Inl::Break => other,
                            Inl::Custom { .. } => return Err(err("unexpected node type")),
                        });
                    }
                }
                Some("text") => nodes.extend(styled_text_nodes(item, block_type)?),
                Some(ty) => nodes.push(Inl::Custom {
                    ty: ty.to_owned(),
                    props: item.get("props").cloned().unwrap_or(Json::Null),
                }),
                None => return Err(err("inline content without a type")),
            },
            _ => return Err(err("unexpected inline content")),
        }
    }
    Ok(nodes)
}

fn mark_element(dom: &mut Dom, mark: &Mark) -> NodeId {
    match mark.rank {
        0 => dom.create_element("strong"),
        1 => dom.create_element("em"),
        2 => dom.create_element("u"),
        3 => dom.create_element("s"),
        4 => dom.create_element("code"),
        LINK_RANK => {
            let a = dom.create_element("a");
            dom.set_attr(a, "href", &mark.value);
            a
        }
        _ => dom.create_element("span"),
    }
}

/// `createInlineContentSpec` `toExternalHTML` of the memry inline specs.
fn custom_dom(dom: &mut Dom, ty: &str, props: &Json) -> Result<NodeId, ConvertError> {
    let pstr = |name: &str| -> String {
        props
            .get(name)
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let span_text = |dom: &mut Dom, text: &str| {
        let span = dom.create_element("span");
        let t = dom.create_text(text);
        dom.append_child(span, t);
        span
    };
    Ok(match ty {
        "wikiLink" => {
            let (target, alias) = (pstr("target"), pstr("alias"));
            let label = if !alias.is_empty() && alias != target {
                format!("[[{target}|{alias}]]")
            } else {
                format!("[[{target}]]")
            };
            let mut node = dom.create_text(&label);
            for (prop, tag) in [
                ("bold", "strong"),
                ("italic", "em"),
                ("underline", "u"),
                ("strike", "s"),
                ("code", "code"),
            ]
            .iter()
            .rev()
            {
                if props.get(*prop) == Some(&Json::Bool(true)) {
                    let wrap = dom.create_element(tag);
                    dom.append_child(wrap, node);
                    node = wrap;
                }
            }
            let span = dom.create_element("span");
            dom.append_child(span, node);
            span
        }
        "linkMention" => span_text(dom, &link_mention_token(&pstr("url"))),
        "hashTag" => span_text(dom, &format!("#{}", pstr("tag"))),
        "dateMention" => span_text(dom, &date_mention_token(props)?),
        "inlineImage" => {
            let img = dom.create_element("img");
            dom.set_attr(img, "src", &pstr("src"));
            dom.set_attr(
                img,
                "alt",
                &inline_image_alt(&pstr("alt"), props.get("width")),
            );
            img
        }
        "inlineCheckbox" => {
            let checked = match props.get("checked") {
                Some(Json::String(s)) => s == "true",
                Some(v) => v == &Json::Bool(true),
                None => false,
            };
            span_text(dom, if checked { "[x] " } else { "[ ] " })
        }
        "htmlComment" => span_text(dom, &encode_html_comment_token(&pstr("source"))),
        other => return Err(err(format!("node type {other} not found in schema"))),
    })
}

const TOKEN_UNSAFE: &[(char, &str)] = &[
    ('!', "%21"),
    ('\'', "%27"),
    ('(', "%28"),
    (')', "%29"),
    ('*', "%2A"),
    ('~', "%7E"),
    ('_', "%5F"),
];

/// `serializeLinkMentionToken`.
fn link_mention_token(url: &str) -> String {
    let mut out = String::new();
    for c in encode_uri_component(url).chars() {
        match TOKEN_UNSAFE.iter().find(|(u, _)| *u == c) {
            Some((_, enc)) => out.push_str(enc),
            None => out.push(c),
        }
    }
    format!("((mention:{out}))")
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

/// `serializeDateMentionToken`: `btoa(JSON.stringify(data))` with the url-safe swaps.
fn date_mention_token(props: &Json) -> Result<String, ConvertError> {
    let get = |name: &str, default: &str| -> Json {
        props
            .get(name)
            .cloned()
            .unwrap_or_else(|| Json::from(default))
    };
    let mut data = serde_json::Map::new();
    data.insert("anchorId".into(), get("anchorId", ""));
    data.insert("dateISO".into(), get("dateISO", ""));
    data.insert(
        "hasTime".into(),
        props.get("hasTime").cloned().unwrap_or(Json::Bool(false)),
    );
    data.insert("dateFormat".into(), get("dateFormat", "relative"));
    data.insert("remind".into(), get("remind", "none"));
    data.insert("timeFormat".into(), get("timeFormat", "system"));
    let json = Json::Object(data).to_string();
    // `btoa` throws above U+00FF; the caller keeps the file.
    let bytes: Option<Vec<u8>> = json
        .chars()
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect();
    let bytes = bytes.ok_or_else(|| err("btoa: character out of range"))?;
    let encoded = base64(&bytes).replace('+', ",").replace('/', ";");
    Ok(format!("((date:{}))", encoded.trim_end_matches('=')))
}

/// `Number(value)` of a JSON value.
fn js_number_of(value: Option<&Json>) -> f64 {
    match value {
        Some(Json::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(s)) => js_number(s),
        Some(Json::Bool(b)) => f64::from(u8::from(*b)),
        Some(Json::Null) => 0.0,
        _ => f64::NAN,
    }
}

fn to_width(value: Option<&Json>) -> f64 {
    let width = js_round(js_number_of(value));
    if width.is_finite() && width > 0.0 {
        width
    } else {
        0.0
    }
}

fn inline_image_alt(alt: &str, width: Option<&Json>) -> String {
    let px = to_width(width);
    if px > 0.0 {
        format!("{alt}|{px}")
    } else {
        alt.to_owned()
    }
}

/// `serializeImageBlockAlt`: the width rides in the alt unless it is the default 600.
pub(super) fn image_block_alt(name: &str, preview_width: Option<&Json>) -> String {
    let width = to_width(preview_width);
    inline_image_alt(
        name,
        Some(&Json::from(if width == 600.0 { 0.0 } else { width })),
    )
}

/// One node of a top-level block: its marks wrap it, last mark innermost.
fn node_dom(dom: &mut Dom, node: &Inl) -> Result<NodeId, ConvertError> {
    match node {
        Inl::Break => Ok(dom.create_element("br")),
        Inl::Custom { ty, props } => custom_dom(dom, ty, props),
        Inl::Text { text, marks } => {
            let mut out = dom.create_text(text);
            for mark in marks.iter().rev() {
                let wrap = mark_element(dom, mark);
                dom.append_child(wrap, out);
                out = wrap;
            }
            Ok(out)
        }
    }
}

/// `DOMSerializer.serializeFragment` over `nodes`: a mark stays open across
/// neighbours that begin with the same marks.
pub(super) fn pm_fragment(
    dom: &mut Dom,
    nodes: &[Inl],
    parent: NodeId,
) -> Result<(), ConvertError> {
    let mut active: Vec<(Mark, NodeId)> = Vec::new();
    for node in nodes {
        let marks: &[Mark] = match node {
            Inl::Text { marks, .. } => marks,
            _ => &[],
        };
        let mut keep = 0;
        while keep < active.len() && keep < marks.len() && marks[keep] == active[keep].0 {
            keep += 1;
        }
        active.truncate(keep);
        let mut top = active.last().map_or(parent, |(_, el)| *el);
        for mark in &marks[keep..] {
            let el = mark_element(dom, mark);
            dom.append_child(top, el);
            active.push((mark.clone(), el));
            top = el;
        }
        let rendered = match node {
            Inl::Text { text, .. } => dom.create_text(text),
            Inl::Break => dom.create_element("br"),
            Inl::Custom { ty, props } => custom_dom(dom, ty, props)?,
        };
        dom.append_child(top, rendered);
    }
    Ok(())
}

/// `serializeInlineContentExternalHTML`: the nodes a block's content becomes.
pub(super) fn serialize_content(
    dom: &mut Dom,
    content: &Json,
    block_type: &str,
) -> Result<Vec<NodeId>, ConvertError> {
    if content.get("type").and_then(Json::as_str) == Some("tableContent") {
        return table::rows(dom, content);
    }
    let nodes = inline_content_nodes(content, Some(block_type))?;
    nodes.iter().map(|n| node_dom(dom, n)).collect()
}

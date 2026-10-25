//! Normalisation of the structured comment metadata (mentions, attachments,
//! format ranges), the body hash, and their JSON text as `JSON.stringify`
//! writes it.

use serde_json::Value;

use super::types::{
    CRITIC_MARKUP_COMMENT_FORMAT_MARKS, CriticMarkupAttachmentType,
    CriticMarkupCommentAttachmentRef, CriticMarkupCommentFormatMark,
    CriticMarkupCommentFormatRange, CriticMarkupCommentMentionKind, CriticMarkupCommentMentionRef,
};
use super::units::utf16_len;
use super::uri::decode_uri_component;
use crate::markdown::frontmatter::js::{js_trim, number_to_string};

pub(super) const COMMENT_FORMAT_VERSION: f64 = 1.0;

const BASE36: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// `(n >>> 0).toString(36)`.
fn base36(mut n: u32) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(BASE36[(n % 36) as usize]);
        n /= 36;
    }
    digits.reverse();
    String::from_utf8_lossy(&digits).into_owned()
}

/// The 33-multiplier string hash of `parser.ts`, over UTF-16 code units.
pub(super) fn hash(value: &str) -> String {
    let mut result: i32 = 5381;
    for unit in value.encode_utf16() {
        result = result.wrapping_mul(33) ^ i32::from(unit);
    }
    base36(result as u32)
}

/// Fingerprint of the body the format ranges were measured against.
pub fn critic_markup_comment_body_hash(body: &str) -> String {
    hash(js_trim(body))
}

fn non_empty(item: &Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

pub fn normalize_critic_markup_comment_mentions(
    value: &Value,
) -> Option<Vec<CriticMarkupCommentMentionRef>> {
    let items = value.as_array()?;
    let mentions: Vec<_> = items
        .iter()
        .filter_map(|item| {
            if !item.is_object() {
                return None;
            }
            let kind = CriticMarkupCommentMentionKind::parse(item.get("kind")?.as_str()?)?;
            Some(CriticMarkupCommentMentionRef {
                kind,
                ref_id: non_empty(item, "refId")?,
                label: non_empty(item, "label")?,
            })
        })
        .collect();
    (!mentions.is_empty()).then_some(mentions)
}

pub fn normalize_critic_markup_comment_attachments(
    value: &Value,
) -> Option<Vec<CriticMarkupCommentAttachmentRef>> {
    let items = value.as_array()?;
    let attachments: Vec<_> = items
        .iter()
        .filter_map(|item| {
            if !item.is_object() {
                return None;
            }
            Some(CriticMarkupCommentAttachmentRef {
                id: non_empty(item, "id")?,
                name: non_empty(item, "name")?,
                path: non_empty(item, "path")?,
                size: item.get("size").and_then(Value::as_f64),
                mime_type: item
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                attachment_type: match item.get("type").and_then(Value::as_str) {
                    Some("image") => Some(CriticMarkupAttachmentType::Image),
                    Some("file") => Some(CriticMarkupAttachmentType::File),
                    _ => None,
                },
            })
        })
        .collect();
    (!attachments.is_empty()).then_some(attachments)
}

/// Marks deduplicated and put in canonical order; non-marks are dropped.
fn normalize_format_marks(value: &Value) -> Vec<CriticMarkupCommentFormatMark> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let wanted: Vec<_> = items
        .iter()
        .filter_map(|item| CriticMarkupCommentFormatMark::parse(item.as_str()?))
        .collect();
    CRITIC_MARKUP_COMMENT_FORMAT_MARKS
        .into_iter()
        .filter(|mark| wanted.contains(mark))
        .collect()
}

/// Ranges that start in the body, clamped to it, in canonical order. The marks
/// of every range are put in canonical order too.
pub fn normalize_format_range_list(
    ranges: &[CriticMarkupCommentFormatRange],
    body_length: usize,
) -> Option<Vec<CriticMarkupCommentFormatRange>> {
    let body_length = body_length as f64;
    let mut out: Vec<CriticMarkupCommentFormatRange> = ranges
        .iter()
        .filter_map(|range| {
            let (start, end) = (range.start, range.end);
            if !start.is_finite() || start < 0.0 {
                return None;
            }
            if !end.is_finite() || end <= start || start >= body_length {
                return None;
            }
            let marks: Vec<_> = CRITIC_MARKUP_COMMENT_FORMAT_MARKS
                .into_iter()
                .filter(|mark| range.marks.contains(mark))
                .collect();
            (!marks.is_empty()).then(|| CriticMarkupCommentFormatRange {
                start,
                end: end.min(body_length),
                marks,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.end
                    .partial_cmp(&b.end)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    (!out.is_empty()).then_some(out)
}

pub fn normalize_critic_markup_comment_format_ranges(
    value: &Value,
    body_length: usize,
) -> Option<Vec<CriticMarkupCommentFormatRange>> {
    let items = value.as_array()?;
    let raw: Vec<_> = items
        .iter()
        .filter_map(|item| {
            if !item.is_object() {
                return None;
            }
            Some(CriticMarkupCommentFormatRange {
                start: item.get("start")?.as_f64()?,
                end: item.get("end")?.as_f64()?,
                marks: normalize_format_marks(item.get("marks").unwrap_or(&Value::Null)),
            })
        })
        .collect();
    normalize_format_range_list(&raw, body_length)
}

/// The ranges of a `format=` metadata field, or `None` when the field does not
/// decode, is of another version, or was measured against another body.
pub fn parse_critic_markup_comment_format(
    encoded: Option<&str>,
    body: &str,
) -> Option<Vec<CriticMarkupCommentFormatRange>> {
    let encoded = encoded.filter(|text| !text.is_empty())?;
    let payload: Value = serde_json::from_str(&decode_uri_component(encoded)?).ok()?;
    if !payload.is_object() && !payload.is_array() {
        return None;
    }
    if payload.get("v").and_then(Value::as_f64) != Some(COMMENT_FORMAT_VERSION) {
        return None;
    }
    if payload.get("hash").and_then(Value::as_str) != Some(&critic_markup_comment_body_hash(body)) {
        return None;
    }
    normalize_critic_markup_comment_format_ranges(
        payload.get("ranges").unwrap_or(&Value::Null),
        utf16_len(body),
    )
}

/// `JSON.stringify` of a string.
fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

fn json_list<T>(items: &[T], one: impl Fn(&T) -> String) -> String {
    format!("[{}]", items.iter().map(one).collect::<Vec<_>>().join(","))
}

pub(super) fn mentions_json(mentions: &[CriticMarkupCommentMentionRef]) -> String {
    json_list(mentions, |m| {
        format!(
            "{{\"kind\":{},\"refId\":{},\"label\":{}}}",
            json_string(m.kind.as_str()),
            json_string(&m.ref_id),
            json_string(&m.label)
        )
    })
}

pub(super) fn attachments_json(attachments: &[CriticMarkupCommentAttachmentRef]) -> String {
    json_list(attachments, |a| {
        let mut out = format!(
            "{{\"id\":{},\"name\":{},\"path\":{}",
            json_string(&a.id),
            json_string(&a.name),
            json_string(&a.path)
        );
        if let Some(size) = a.size {
            out.push_str(&format!(",\"size\":{}", number_to_string(size)));
        }
        if let Some(mime) = &a.mime_type {
            out.push_str(&format!(",\"mimeType\":{}", json_string(mime)));
        }
        if let Some(kind) = a.attachment_type {
            let name = match kind {
                CriticMarkupAttachmentType::Image => "image",
                CriticMarkupAttachmentType::File => "file",
            };
            out.push_str(&format!(",\"type\":\"{name}\""));
        }
        out.push('}');
        out
    })
}

pub(super) fn format_payload_json(hash: &str, ranges: &[CriticMarkupCommentFormatRange]) -> String {
    let ranges = json_list(ranges, |r| {
        let marks = json_list(&r.marks, |m| json_string(m.as_str()));
        format!(
            "{{\"start\":{},\"end\":{},\"marks\":{marks}}}",
            number_to_string(r.start),
            number_to_string(r.end)
        )
    });
    format!(
        "{{\"v\":{},\"hash\":{},\"ranges\":{ranges}}}",
        number_to_string(COMMENT_FORMAT_VERSION),
        json_string(hash)
    )
}

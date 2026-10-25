//! The payload of a comment mark: `<metadata> | <body>`, where the metadata is
//! `key=value;key=value`.

use std::collections::HashMap;

use serde_json::Value;

use super::format::{
    attachments_json, critic_markup_comment_body_hash, format_payload_json, hash, mentions_json,
    normalize_critic_markup_comment_attachments, normalize_critic_markup_comment_mentions,
    normalize_format_range_list, parse_critic_markup_comment_format,
};
use super::types::{
    CriticMarkupCommentAttachmentRef, CriticMarkupCommentFormatRange,
    CriticMarkupCommentMentionRef, CriticMarkupKind, CriticMarkupMark,
};
use super::units::utf16_len;
use super::uri::{decode_uri_component, encode_uri_component};
use crate::markdown::frontmatter::js::{js_trim, parse_int};

const COMMENT_ID_TIMESTAMP_MIN: f64 = 1_577_836_800_000.0;
const COMMENT_ID_TIMESTAMP_MAX: f64 = 4_102_444_800_000.0;

#[derive(Default)]
pub(super) struct CommentPayload {
    pub id: Option<String>,
    pub metadata: Option<String>,
    pub body: String,
    pub created_at: Option<f64>,
    pub mentions: Option<Vec<CriticMarkupCommentMentionRef>>,
    pub attachments: Option<Vec<CriticMarkupCommentAttachmentRef>>,
    pub format_ranges: Option<Vec<CriticMarkupCommentFormatRange>>,
}

/// `Number(text)` for the strings that reach `parseCommentCreatedAt`.
fn js_to_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, radix: u32| -> f64 {
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0.0_f64;
        for ch in digits.chars() {
            let Some(digit) = ch.to_digit(radix) else {
                return f64::NAN;
            };
            value = value * f64::from(radix) + f64::from(digit);
        }
        value
    };
    let lower = text.get(..2).map(str::to_ascii_lowercase);
    match lower.as_deref() {
        Some("0x") => return radix(&text[2..], 16),
        Some("0o") => return radix(&text[2..], 8),
        Some("0b") => return radix(&text[2..], 2),
        _ => {}
    }
    let (negative, unsigned) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    if unsigned == "Infinity" {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let bytes = unsigned.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let int_len = digits(0);
    let mut end = int_len;
    let mut frac_len = 0;
    if bytes.get(end) == Some(&b'.') {
        frac_len = digits(end + 1);
        end += 1 + frac_len;
    }
    if int_len == 0 && frac_len == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut at = end + 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exp_len = digits(at);
        if exp_len == 0 {
            return f64::NAN;
        }
        end = at + exp_len;
    }
    if end != bytes.len() {
        return f64::NAN;
    }
    let parsed = unsigned.parse::<f64>().unwrap_or(f64::NAN);
    if negative { -parsed } else { parsed }
}

fn parse_comment_created_at(value: Option<&str>) -> Option<f64> {
    let parsed = js_to_number(value.filter(|text| !text.is_empty())?);
    (parsed.is_finite() && parsed > 0.0).then_some(parsed)
}

/// Comment ids from the composer embed the creation time as base36
/// (`critic-comment-<Date.now().toString(36)>-<random>`).
pub(super) fn created_at_from_comment_mark_id(id: Option<&str>) -> Option<f64> {
    let rest = id?.strip_prefix("critic-comment-")?;
    let run = rest
        .bytes()
        .take_while(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
        .count();
    if run == 0 || rest.as_bytes().get(run) != Some(&b'-') {
        return None;
    }
    let parsed = parse_int(&rest[..run], 36);
    (COMMENT_ID_TIMESTAMP_MIN..COMMENT_ID_TIMESTAMP_MAX)
        .contains(&parsed)
        .then_some(parsed)
}

fn parse_metadata_fields(metadata: &str) -> HashMap<&str, &str> {
    let mut fields = HashMap::new();
    for part in metadata.split(';') {
        match part.find('=') {
            Some(separator) if separator > 0 => {
                fields.insert(&part[..separator], &part[separator + 1..]);
            }
            _ => {}
        }
    }
    fields
}

fn parse_structured<T>(
    encoded: Option<&str>,
    normalize: impl Fn(&Value) -> Option<Vec<T>>,
) -> Option<Vec<T>> {
    let encoded = encoded.filter(|text| !text.is_empty())?;
    let value: Value = serde_json::from_str(&decode_uri_component(encoded)?).ok()?;
    normalize(&value)
}

pub(super) fn parse_comment_payload(payload: &str) -> CommentPayload {
    let separator = payload.find(" | ");
    let metadata = separator.map(|at| js_trim(&payload[..at]).to_owned());
    let body = match separator {
        Some(at) => js_trim(&payload[at + 3..]),
        None => js_trim(payload),
    };
    let fields = match metadata.as_deref() {
        Some(text) if !text.is_empty() => parse_metadata_fields(text),
        _ => HashMap::new(),
    };
    CommentPayload {
        id: fields.get("id").map(|id| (*id).to_owned()),
        created_at: parse_comment_created_at(fields.get("createdAt").copied()),
        mentions: parse_structured(
            fields.get("mentions").copied(),
            normalize_critic_markup_comment_mentions,
        ),
        attachments: parse_structured(
            fields.get("attachments").copied(),
            normalize_critic_markup_comment_attachments,
        ),
        format_ranges: parse_critic_markup_comment_format(fields.get("format").copied(), body),
        body: body.to_owned(),
        metadata,
    }
}

fn build_comment_metadata(mark: &CriticMarkupMark, body: &str) -> String {
    let default = || format!("id={};type=comment", mark.id);
    let trimmed_metadata = mark.metadata.as_deref().map(js_trim).unwrap_or("");
    let metadata = if trimmed_metadata.is_empty() {
        default()
    } else {
        trimmed_metadata.to_owned()
    };
    if mark.mentions.is_none() && mark.attachments.is_none() && mark.format_ranges.is_none() {
        return metadata;
    }

    let mut parts: Vec<String> = metadata
        .split(';')
        .map(|part| js_trim(part).to_owned())
        .filter(|part| match part.find('=') {
            Some(separator) if separator > 0 => {
                !matches!(&part[..separator], "mentions" | "attachments" | "format")
            }
            _ => !part.is_empty(),
        })
        .collect();

    let mentions = mark.mentions.as_deref().and_then(|items| {
        let kept: Vec<_> = items
            .iter()
            .filter(|m| !m.ref_id.is_empty() && !m.label.is_empty())
            .cloned()
            .collect();
        (!kept.is_empty()).then_some(kept)
    });
    let attachments = mark.attachments.as_deref().and_then(|items| {
        let kept: Vec<_> = items
            .iter()
            .filter(|a| !a.id.is_empty() && !a.name.is_empty() && !a.path.is_empty())
            .map(|a| CriticMarkupCommentAttachmentRef {
                size: a.size.filter(|size| size.is_finite()),
                ..a.clone()
            })
            .collect();
        (!kept.is_empty()).then_some(kept)
    });
    let trimmed_body = js_trim(body);
    let format_ranges = mark
        .format_ranges
        .as_deref()
        .and_then(|ranges| normalize_format_range_list(ranges, utf16_len(trimmed_body)));
    if let Some(mentions) = mentions {
        parts.push(format!(
            "mentions={}",
            encode_uri_component(&mentions_json(&mentions))
        ));
    }
    if let Some(attachments) = attachments {
        parts.push(format!(
            "attachments={}",
            encode_uri_component(&attachments_json(&attachments))
        ));
    }
    if let Some(ranges) = format_ranges {
        let payload = format_payload_json(&critic_markup_comment_body_hash(trimmed_body), &ranges);
        parts.push(format!("format={}", encode_uri_component(&payload)));
    }
    let joined = parts.join(";");
    if joined.is_empty() { default() } else { joined }
}

/// `<metadata> | <body>` for a comment mark.
pub fn build_comment_payload(mark: &CriticMarkupMark) -> String {
    let body = mark.body.as_deref().unwrap_or("");
    format!("{} | {body}", build_comment_metadata(mark, body))
}

pub(super) fn fallback_mark_id(
    kind: CriticMarkupKind,
    start: usize,
    visible_text: &str,
    extra: &str,
) -> String {
    format!(
        "critic-{}-{start}-{}",
        kind.as_str(),
        hash(&format!("{visible_text}:{extra}"))
    )
}

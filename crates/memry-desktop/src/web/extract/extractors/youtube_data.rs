//! The data side of the YouTube extractor: caption XML, chapters and the JSON accessors.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, parse_float, parse_int, to_number, trim};
use crate::web::extract::utils::json::JsValue;
use crate::web::extract::utils::transcript::{Chapter, build_transcript};

use super::youtube_group::{Raw, group_transcript_segments};

static P_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#"<p{WS}+t="([0-9]+)"[^>]*>((?s:.)*?)</p>"#)).expect("static")
});
static S_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<s[^>]*>([^<]*)</s>").expect("static"));
static TEXT_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"<text{WS}+start="([^"]*)"[^>]*>((?s:.)*?)</text>"#
    ))
    .expect("static")
});
static ANY_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").expect("static"));
static SPACE_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{WS}{{2,}}")).expect("static"));
static HEX_ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&#x([0-9a-fA-F]+);").expect("static"));
static DEC_ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#([0-9]+);").expect("static"));

pub(super) struct Transcript {
    pub(super) html: String,
    pub(super) language: Option<String>,
}

pub(super) fn path<'a>(value: &'a JsValue, keys: &[&str]) -> Option<&'a JsValue> {
    keys.iter().try_fold(value, |v, k| v.get(k))
}

pub(super) fn string_at(value: &JsValue, keys: &[&str]) -> String {
    path(value, keys)
        .filter(|v| v.truthy())
        .map(JsValue::to_js_string)
        .unwrap_or_default()
}

/// `parseTimestamp(ts)`: seconds, `None` for JS `null`.
pub(super) fn parse_timestamp(ts: &str) -> Option<f64> {
    let parts: Vec<f64> = ts.split(':').map(to_number).collect();
    if parts.iter().any(|p| p.is_nan()) {
        return None;
    }
    match parts.as_slice() {
        [h, m, s] => Some(h * 3600.0 + m * 60.0 + s),
        [m, s] => Some(m * 60.0 + s),
        _ => None,
    }
}

pub(super) fn chapters_from_player_bar(data: &JsValue) -> Vec<Chapter> {
    let mut chapters = Vec::new();
    let Some(JsValue::Array(panels)) = path(
        data,
        &[
            "playerOverlays",
            "playerOverlayRenderer",
            "decoratedPlayerBarRenderer",
            "decoratedPlayerBarRenderer",
            "playerBar",
            "multiMarkersPlayerBarRenderer",
            "markersMap",
        ],
    ) else {
        return chapters;
    };
    for panel in panels {
        let Some(JsValue::Array(markers)) = path(panel, &["value", "chapters"]) else {
            continue;
        };
        for marker in markers {
            let Some(ch) = marker.get("chapterRenderer").filter(|c| c.truthy()) else {
                continue;
            };
            let title = string_at(ch, &["title", "simpleText"]);
            if let (false, Some(JsValue::Number(ms))) =
                (title.is_empty(), ch.get("timeRangeStartMillis"))
            {
                chapters.push(Chapter {
                    title,
                    start: ms / 1000.0,
                });
            }
        }
    }
    chapters
}

pub(super) fn chapters_from_panels(data: &JsValue) -> Vec<Chapter> {
    let mut chapters = Vec::new();
    let Some(JsValue::Array(panels)) = data.get("engagementPanels") else {
        return chapters;
    };
    for panel in panels {
        let Some(JsValue::Array(items)) = path(
            panel,
            &[
                "engagementPanelSectionListRenderer",
                "content",
                "macroMarkersListRenderer",
                "contents",
            ],
        ) else {
            continue;
        };
        for item in items {
            let Some(renderer) = item
                .get("macroMarkersListItemRenderer")
                .filter(|r| r.truthy())
            else {
                continue;
            };
            let title = string_at(renderer, &["title", "simpleText"]);
            let time = string_at(renderer, &["timeDescription", "simpleText"]);
            if title.is_empty() || time.is_empty() {
                continue;
            }
            if let Some(start) = parse_timestamp(&time) {
                chapters.push(Chapter { title, start });
            }
        }
    }
    chapters
}

pub(super) fn chapters_from(data: &JsValue) -> Vec<Chapter> {
    let bar = chapters_from_player_bar(data);
    if bar.is_empty() {
        chapters_from_panels(data)
    } else {
        bar
    }
}

pub(super) fn decode_entities(text: &str) -> Result<String, ExtractError> {
    let t = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    let code = |digits: &str, radix: u32| -> Result<String, ExtractError> {
        let n = u32::from_str_radix(digits, radix)
            .ok()
            .and_then(|n| (n <= 0x10FFFF).then_some(n));
        match n {
            Some(n) => Ok(char::from_u32(n).unwrap_or('\u{FFFD}').to_string()),
            None => Err(ExtractError::Js("RangeError: Invalid code point".into())),
        }
    };
    let mut failure = None;
    let t = HEX_ENTITY
        .replace_all(&t, |m: &regex::Captures| {
            code(&m[1], 16).unwrap_or_else(|e| {
                failure = Some(e);
                String::new()
            })
        })
        .into_owned();
    if let Some(e) = failure {
        return Err(e);
    }
    let t = DEC_ENTITY
        .replace_all(&t, |m: &regex::Captures| {
            code(&m[1], 10).unwrap_or_else(|e| {
                failure = Some(e);
                String::new()
            })
        })
        .into_owned();
    failure.map_or(Ok(t), Err)
}

pub(super) fn clean_text(raw: &str) -> String {
    let t = raw.replace('\n', " ");
    SPACE_RUN.replace_all(&t, " ").into_owned()
}

/// `parseTranscriptXml(xml, languageCode, chapters)`; `Err` is a thrown `RangeError`.
pub(super) fn parse_transcript_xml(
    xml: &str,
    language: &str,
    chapters: &[Chapter],
) -> Result<Option<Transcript>, ExtractError> {
    let mut segments: Vec<Raw> = Vec::new();
    for m in P_TAG.captures_iter(xml) {
        let start_ms = parse_int(&m[1]).map_or(f64::NAN, |n| n as f64);
        let inner = &m[2];
        let mut text: String = S_TAG
            .captures_iter(inner)
            .map(|s| s[1].to_string())
            .collect();
        if text.is_empty() {
            text = ANY_TAG.replace_all(inner, "").into_owned();
        }
        let text = decode_entities(&clean_text(&text))?;
        if !trim(&text).is_empty() {
            segments.push(Raw {
                start: start_ms / 1000.0,
                text: trim(&text).to_string(),
            });
        }
    }
    if segments.is_empty() {
        for m in TEXT_TAG.captures_iter(xml) {
            let start = parse_float(&m[1]).unwrap_or(f64::NAN);
            let text = decode_entities(&clean_text(&ANY_TAG.replace_all(&m[2], "")))?;
            if !trim(&text).is_empty() {
                segments.push(Raw {
                    start,
                    text: trim(&text).to_string(),
                });
            }
        }
    }
    if segments.is_empty() {
        return Ok(None);
    }
    let groups = group_transcript_segments(&segments);
    let (html, _) = build_transcript("youtube", &groups, chapters);
    Ok(Some(Transcript {
        html,
        language: Some(language.to_string()),
    }))
}

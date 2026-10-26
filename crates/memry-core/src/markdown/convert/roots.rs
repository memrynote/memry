//! The side-channel roots of a note's Y.Doc that the converter reads and
//! writes next to the `prosemirror` fragment (protocol 12.5.0): the markdown
//! source record (`markdown-source.ts`), CriticMarkup marks
//! (`critic-markup/yjs.ts`) and link reference definitions and usages
//! (`link-references.ts`). Reads normalize every entry and drop what is
//! malformed; writes replace a root only when its content changed.

use serde_json::Value as Json;
use yrs::{Any, Array as _, ArrayRef, Map as _, MapRef, Out, ReadTxn, TransactionMut, WriteTxn};

use crate::markdown::pm::model::{any_to_json, json_to_any};
use crate::markdown::shared::critic_markup::{
    CriticMarkupKind, CriticMarkupMark, normalize_critic_markup_comment_attachments,
    normalize_critic_markup_comment_format_ranges, normalize_critic_markup_comment_mentions,
};
use crate::markdown::shared::link_references::{
    LINK_REFERENCE_DEFINITIONS_ARRAY, LINK_REFERENCE_USAGES_ARRAY, LinkReferenceDefinition,
    LinkReferenceUsage,
};

pub const MARKDOWN_SOURCE_MAP: &str = "markdownSource";
pub const CRITIC_MARKUP_MARKS_ARRAY: &str = "criticMarkupMarks";
const RECORD_KEY: &str = "record";

/// `MarkdownSourceRecord`: `html_comments` is set when the document was read
/// from `source` with HTML comments kept as nodes (AF-015).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownSourceRecord {
    pub source: String,
    pub html_comments: bool,
}

/// The JSON of a stored value: a shared type read as its content.
pub fn out_json<T: ReadTxn>(value: Out, txn: &T) -> Json {
    let any = match value {
        Out::Any(any) => any,
        other => yrs::types::ToJson::to_json(&other, txn),
    };
    any_to_json(&any).unwrap_or(Json::Null)
}

pub fn read_array_json<T: ReadTxn>(txn: &T, name: &str) -> Vec<Json> {
    use yrs::Array as _;
    match txn.get_array(name) {
        Some(array) => array.iter(txn).map(|v| out_json(v, txn)).collect(),
        None => Vec::new(),
    }
}

/// Replaces a root array's content with `next` unless it already holds it.
/// Equality is by JSON value (the TypeScript compares `JSON.stringify`).
pub(crate) fn replace_array(txn: &mut TransactionMut, name: &str, next: &[Json]) {
    let array: ArrayRef = txn.get_or_insert_array(name);
    let current: Vec<Json> = array.iter(txn).map(|v| out_json(v, txn)).collect();
    if current == next {
        return;
    }
    let length = array.len(txn);
    if length > 0 {
        array.remove_range(txn, 0, length);
    }
    if !next.is_empty() {
        array.insert_range(txn, 0, next.iter().map(json_to_any).collect::<Vec<Any>>());
    }
}

fn record_of(value: &Json) -> Option<MarkdownSourceRecord> {
    let source = value.get("source")?.as_str()?;
    Some(MarkdownSourceRecord {
        source: source.to_owned(),
        html_comments: value.get("htmlComments") == Some(&Json::Bool(true)),
    })
}

/// `readMarkdownSourceRecordFromYDoc`.
pub fn read_markdown_source_record<T: ReadTxn>(txn: &T) -> Option<MarkdownSourceRecord> {
    let map: MapRef = txn.get_map(MARKDOWN_SOURCE_MAP)?;
    record_of(&out_json(map.get(txn, RECORD_KEY)?, txn))
}

/// `writeMarkdownSourceToYDoc`: store the source, or clear it with `None`.
pub fn write_markdown_source(txn: &mut TransactionMut, source: Option<&str>) {
    let map: MapRef = txn.get_or_insert_map(MARKDOWN_SOURCE_MAP);
    let Some(source) = source else {
        if map.contains_key(txn, RECORD_KEY) {
            map.remove(txn, RECORD_KEY);
        }
        return;
    };
    let current = map
        .get(txn, RECORD_KEY)
        .and_then(|v| record_of(&out_json(v, txn)));
    if current.is_some_and(|c| c.source == source && c.html_comments) {
        return;
    }
    let record = json_to_any(&serde_json::json!({"source": source, "htmlComments": true}));
    map.insert(txn, RECORD_KEY, record);
}

fn is_finite_number(value: Option<&Json>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}

/// `normalizeCriticMarkupMark`.
fn normalize_mark(value: &Json) -> Option<CriticMarkupMark> {
    if !value.is_object() {
        return None;
    }
    let id = value.get("id")?.as_str()?.to_owned();
    let kind = match value.get("kind")?.as_str()? {
        "addition" => CriticMarkupKind::Addition,
        "deletion" => CriticMarkupKind::Deletion,
        "substitution" => CriticMarkupKind::Substitution,
        "comment" => CriticMarkupKind::Comment,
        _ => return None,
    };
    let visible_text = value.get("visibleText")?.as_str()?.to_owned();
    let start = is_finite_number(value.get("start"))?;
    let end = is_finite_number(value.get("end"))?;
    if start < 0.0 || end < start {
        return None;
    }
    let body = value.get("body").and_then(Json::as_str).map(str::to_owned);
    let body_length = crate::markdown::frontmatter::js::js_trim(body.as_deref().unwrap_or(""))
        .encode_utf16()
        .count();
    let null = Json::Null;
    Some(CriticMarkupMark {
        id,
        kind,
        visible_text,
        original_text: value
            .get("originalText")
            .and_then(Json::as_str)
            .map(str::to_owned),
        body,
        metadata: value
            .get("metadata")
            .and_then(Json::as_str)
            .map(str::to_owned),
        created_at: is_finite_number(value.get("createdAt")),
        mentions: normalize_critic_markup_comment_mentions(value.get("mentions").unwrap_or(&null)),
        attachments: normalize_critic_markup_comment_attachments(
            value.get("attachments").unwrap_or(&null),
        ),
        format_ranges: normalize_critic_markup_comment_format_ranges(
            value.get("formatRanges").unwrap_or(&null),
            body_length,
        ),
        start: start as i64,
        end: end as i64,
    })
}

/// `readCriticMarkupMarksFromYDoc`.
pub fn read_critic_marks<T: ReadTxn>(txn: &T) -> Vec<CriticMarkupMark> {
    read_array_json(txn, CRITIC_MARKUP_MARKS_ARRAY)
        .iter()
        .filter_map(normalize_mark)
        .collect()
}

/// `writeCriticMarkupMarksToYDoc`.
pub fn write_critic_marks(txn: &mut TransactionMut, marks: &[CriticMarkupMark]) {
    let next: Vec<Json> = marks
        .iter()
        .filter_map(|mark| {
            let json = serde_json::to_value(mark).ok()?;
            normalize_mark(&json).map(|m| serde_json::to_value(m).unwrap_or(Json::Null))
        })
        .collect();
    replace_array(txn, CRITIC_MARKUP_MARKS_ARRAY, &next);
}

fn normalize_definition(value: &Json) -> Option<LinkReferenceDefinition> {
    if !value.is_object() {
        return None;
    }
    let gap = value.get("gapBefore").and_then(Json::as_f64);
    Some(LinkReferenceDefinition {
        label: value.get("label")?.as_str()?.to_owned(),
        destination: value.get("destination")?.as_str()?.to_owned(),
        raw: value.get("raw")?.as_str()?.to_owned(),
        gap_before: gap
            .filter(|g| g.is_finite() && *g >= 0.0)
            .map(|g| g as usize),
    })
}

fn normalize_usage(value: &Json) -> Option<LinkReferenceUsage> {
    if !value.is_object() {
        return None;
    }
    let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
    Some(LinkReferenceUsage {
        label: text("label")?,
        destination: text("destination")?,
        text: text("text")?,
        raw: text("raw")?,
    })
}

/// `readLinkReferencesFromYDoc`.
pub fn read_link_references<T: ReadTxn>(
    txn: &T,
) -> (Vec<LinkReferenceDefinition>, Vec<LinkReferenceUsage>) {
    let definitions = read_array_json(txn, LINK_REFERENCE_DEFINITIONS_ARRAY)
        .iter()
        .filter_map(normalize_definition)
        .collect();
    let usages = read_array_json(txn, LINK_REFERENCE_USAGES_ARRAY)
        .iter()
        .filter_map(normalize_usage)
        .collect();
    (definitions, usages)
}

/// `writeLinkReferencesToYDoc`.
pub fn write_link_references(
    txn: &mut TransactionMut,
    definitions: &[LinkReferenceDefinition],
    usages: &[LinkReferenceUsage],
) {
    let as_json = |items: Vec<Result<Json, serde_json::Error>>| -> Vec<Json> {
        items.into_iter().flatten().collect()
    };
    replace_array(
        txn,
        LINK_REFERENCE_DEFINITIONS_ARRAY,
        &as_json(definitions.iter().map(serde_json::to_value).collect()),
    );
    replace_array(
        txn,
        LINK_REFERENCE_USAGES_ARRAY,
        &as_json(usages.iter().map(serde_json::to_value).collect()),
    );
}

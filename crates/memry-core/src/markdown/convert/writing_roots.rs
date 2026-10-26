//! Writing tools side data on a note's Y.Doc (`writing-tools/yjs.ts`):
//! alternatives, ghosted ranges and the overflow list live in three top-level
//! Y.Arrays next to the prosemirror fragment. Reads normalize every entry and
//! drop what is unknown or malformed; writes diff by record id, are
//! idempotent, and keep the fields a newer build added.

use serde_json::{Map, Value as Json, json};
use yrs::{Array as _, ReadTxn, TransactionMut, WriteTxn};

use super::roots::{out_json, read_array_json};
use crate::markdown::pm::model::json_to_any;

pub const WRITING_ALTERNATIVES_ARRAY: &str = "writingAlternatives";
pub const WRITING_GHOSTS_ARRAY: &str = "writingGhosts";
pub const WRITING_OVERFLOW_ARRAY: &str = "writingOverflow";

/// Upper bound on a stored overflow item's HTML; larger values are dropped to text.
pub const WRITING_OVERFLOW_HTML_MAX: usize = 200_000;

/// A JS number as JSON: whole numbers stay integers, as `JSON.stringify` writes them.
pub(crate) fn num(value: f64) -> Json {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        Json::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Json::Null, Json::Number)
    }
}

fn finite(value: Option<&Json>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}

/// `{client, clock}`: a Yjs item id as `Y.relativePositionToJSON` writes it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnchorId {
    pub client: f64,
    pub clock: f64,
}

impl AnchorId {
    fn to_json(self) -> Json {
        json!({"client": num(self.client), "clock": num(self.clock)})
    }
}

/// `Y.relativePositionToJSON` output.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct WritingAnchor {
    pub type_id: Option<AnchorId>,
    pub tname: Option<String>,
    pub item: Option<AnchorId>,
    pub assoc: Option<f64>,
}

impl WritingAnchor {
    pub fn to_json(&self) -> Json {
        let mut map = Map::new();
        if let Some(id) = self.type_id {
            map.insert("type".into(), id.to_json());
        }
        if let Some(name) = &self.tname {
            map.insert("tname".into(), json!(name));
        }
        if let Some(id) = self.item {
            map.insert("item".into(), id.to_json());
        }
        if let Some(assoc) = self.assoc {
            map.insert("assoc".into(), num(assoc));
        }
        Json::Object(map)
    }
}

fn normalize_anchor_id(value: &Json) -> Option<AnchorId> {
    if !value.is_object() {
        return None;
    }
    Some(AnchorId {
        client: finite(value.get("client"))?,
        clock: finite(value.get("clock"))?,
    })
}

fn present<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    value.get(key).filter(|v| !v.is_null())
}

/// `normalizeWritingAnchor`.
pub fn normalize_writing_anchor(value: &Json) -> Option<WritingAnchor> {
    if !value.is_object() {
        return None;
    }
    let mut anchor = WritingAnchor::default();
    if let Some(v) = present(value, "type") {
        anchor.type_id = Some(normalize_anchor_id(v)?);
    }
    if let Some(v) = present(value, "tname") {
        anchor.tname = Some(v.as_str()?.to_owned());
    }
    if let Some(v) = present(value, "item") {
        anchor.item = Some(normalize_anchor_id(v)?);
    }
    if let Some(v) = present(value, "assoc") {
        anchor.assoc = Some(v.as_f64().filter(|n| n.is_finite())?);
    }
    if anchor.item.is_none() && anchor.type_id.is_none() && anchor.tname.is_none() {
        return None;
    }
    Some(anchor)
}

#[derive(Debug, Clone, PartialEq)]
pub struct WritingVariant {
    pub id: String,
    pub text: String,
    /// `user` or `ai`.
    pub source: String,
    pub created_at: f64,
}

impl WritingVariant {
    fn to_json(&self) -> Json {
        json!({"id": self.id, "text": self.text, "source": self.source, "createdAt": num(self.created_at)})
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WritingAlternative {
    pub id: String,
    pub anchor_start: WritingAnchor,
    pub anchor_end: WritingAnchor,
    /// The text the range held when the alternative was made.
    pub original: String,
    pub variants: Vec<WritingVariant>,
    /// The variant shown in the body, or `None` while the original is shown.
    pub active_variant_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WritingGhost {
    pub id: String,
    pub anchor_start: WritingAnchor,
    pub anchor_end: WritingAnchor,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WritingOverflowItem {
    pub id: String,
    pub text: String,
    /// The stashed selection as ProseMirror clipboard HTML.
    pub html: Option<String>,
    pub label: Option<String>,
    pub created_at: f64,
}

fn record_id(value: &Json) -> Option<&str> {
    value
        .get("id")
        .and_then(Json::as_str)
        .filter(|id| !id.is_empty())
}

fn normalize_variant(value: &Json) -> Option<WritingVariant> {
    if !value.is_object() {
        return None;
    }
    let source = value.get("source")?.as_str()?;
    if source != "user" && source != "ai" {
        return None;
    }
    Some(WritingVariant {
        id: record_id(value)?.to_owned(),
        text: value.get("text")?.as_str()?.to_owned(),
        source: source.to_owned(),
        created_at: finite(value.get("createdAt"))?,
    })
}

/// `normalizeWritingAlternative`: a record with no usable variant is no
/// alternative at all.
pub fn normalize_writing_alternative(value: &Json) -> Option<WritingAlternative> {
    if !value.is_object() {
        return None;
    }
    let id = record_id(value)?.to_owned();
    let anchor_start = normalize_writing_anchor(value.get("anchorStart")?)?;
    let anchor_end = normalize_writing_anchor(value.get("anchorEnd")?)?;
    let original = value.get("original")?.as_str()?.to_owned();
    let raw = value.get("variants")?.as_array()?;
    let mut variants: Vec<WritingVariant> = Vec::new();
    for entry in raw {
        if let Some(variant) = normalize_variant(entry)
            && !variants.iter().any(|v| v.id == variant.id)
        {
            variants.push(variant);
        }
    }
    if variants.is_empty() {
        return None;
    }
    let active_variant_id = value
        .get("activeVariantId")
        .and_then(Json::as_str)
        .filter(|active| variants.iter().any(|v| v.id == *active))
        .map(str::to_owned);
    Some(WritingAlternative {
        id,
        anchor_start,
        anchor_end,
        original,
        variants,
        active_variant_id,
    })
}

pub fn normalize_writing_ghost(value: &Json) -> Option<WritingGhost> {
    if !value.is_object() {
        return None;
    }
    Some(WritingGhost {
        id: record_id(value)?.to_owned(),
        anchor_start: normalize_writing_anchor(value.get("anchorStart")?)?,
        anchor_end: normalize_writing_anchor(value.get("anchorEnd")?)?,
    })
}

pub fn normalize_writing_overflow_item(value: &Json) -> Option<WritingOverflowItem> {
    if !value.is_object() {
        return None;
    }
    let text = value
        .get("text")?
        .as_str()
        .filter(|t| !t.is_empty())?
        .to_owned();
    let html = value
        .get("html")
        .and_then(Json::as_str)
        .filter(|h| !h.is_empty() && h.encode_utf16().count() <= WRITING_OVERFLOW_HTML_MAX)
        .map(str::to_owned);
    Some(WritingOverflowItem {
        id: record_id(value)?.to_owned(),
        text,
        html,
        label: value
            .get("label")
            .and_then(Json::as_str)
            .filter(|l| !l.is_empty())
            .map(str::to_owned),
        created_at: finite(value.get("createdAt"))?,
    })
}

/// One stored record kind: how it normalizes, serializes and overlays.
trait Record: Clone {
    fn id(&self) -> &str;
    fn to_json(&self) -> Json;
    fn normalize(value: &Json) -> Option<Self>;
    /// The stored object with this build's fields replaced by `self`.
    fn overlay(&self, raw: &Map<String, Json>) -> Json;
}

/// `overlayKnownFields`: fields a newer build added survive an edit made here;
/// the fields this build owns are authoritative.
fn overlay_known(raw: &Map<String, Json>, record: &Json, known: &[&str]) -> Map<String, Json> {
    let mut out: Map<String, Json> = raw
        .iter()
        .filter(|(key, _)| !known.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if let Json::Object(fields) = record {
        for (key, value) in fields {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

impl Record for WritingAlternative {
    fn id(&self) -> &str {
        &self.id
    }
    fn to_json(&self) -> Json {
        json!({
            "id": self.id,
            "anchorStart": self.anchor_start.to_json(),
            "anchorEnd": self.anchor_end.to_json(),
            "original": self.original,
            "variants": self.variants.iter().map(WritingVariant::to_json).collect::<Vec<_>>(),
            "activeVariantId": self.active_variant_id,
        })
    }
    fn normalize(value: &Json) -> Option<Self> {
        normalize_writing_alternative(value)
    }
    /// An alternative overlaid on its stored object, variant by variant. A
    /// variant this build cannot read is kept as it was.
    fn overlay(&self, raw: &Map<String, Json>) -> Json {
        let raw_variants = raw.get("variants").and_then(Json::as_array);
        let mut by_id: Vec<(&str, &Map<String, Json>)> = Vec::new();
        let mut unreadable: Vec<&Json> = Vec::new();
        for entry in raw_variants.into_iter().flatten() {
            let Some(id) = record_id(entry) else { continue };
            if normalize_variant(entry).is_none() {
                unreadable.push(entry);
            } else if let Some(map) = entry.as_object() {
                by_id.push((id, map));
            }
        }
        let mut variants: Vec<Json> = self
            .variants
            .iter()
            .map(|variant| {
                let json = variant.to_json();
                match by_id.iter().rfind(|(id, _)| *id == variant.id) {
                    Some((_, stored)) => Json::Object(overlay_known(
                        stored,
                        &json,
                        &["id", "text", "source", "createdAt"],
                    )),
                    None => json,
                }
            })
            .collect();
        variants.extend(
            unreadable
                .into_iter()
                .filter(|entry| {
                    let id = record_id(entry).unwrap_or("");
                    !self.variants.iter().any(|v| v.id == id)
                })
                .cloned(),
        );
        let mut out = overlay_known(
            raw,
            &self.to_json(),
            &[
                "id",
                "anchorStart",
                "anchorEnd",
                "original",
                "variants",
                "activeVariantId",
            ],
        );
        out.insert("variants".into(), Json::Array(variants));
        Json::Object(out)
    }
}

impl Record for WritingGhost {
    fn id(&self) -> &str {
        &self.id
    }
    fn to_json(&self) -> Json {
        json!({
            "id": self.id,
            "anchorStart": self.anchor_start.to_json(),
            "anchorEnd": self.anchor_end.to_json(),
        })
    }
    fn normalize(value: &Json) -> Option<Self> {
        normalize_writing_ghost(value)
    }
    fn overlay(&self, raw: &Map<String, Json>) -> Json {
        Json::Object(overlay_known(
            raw,
            &self.to_json(),
            &["id", "anchorStart", "anchorEnd"],
        ))
    }
}

impl Record for WritingOverflowItem {
    fn id(&self) -> &str {
        &self.id
    }
    fn to_json(&self) -> Json {
        let mut map = Map::new();
        map.insert("id".into(), json!(self.id));
        map.insert("text".into(), json!(self.text));
        if let Some(html) = &self.html {
            map.insert("html".into(), json!(html));
        }
        if let Some(label) = &self.label {
            map.insert("label".into(), json!(label));
        }
        map.insert("createdAt".into(), num(self.created_at));
        Json::Object(map)
    }
    fn normalize(value: &Json) -> Option<Self> {
        normalize_writing_overflow_item(value)
    }
    fn overlay(&self, raw: &Map<String, Json>) -> Json {
        Json::Object(overlay_known(
            raw,
            &self.to_json(),
            &["id", "text", "label", "createdAt"],
        ))
    }
}

/// Normalized records, one per id. Two devices can each push a record with the
/// same id while offline; the later entry in array order wins.
fn read_records<T: Record, R: ReadTxn>(txn: &R, name: &str) -> Vec<T> {
    let mut by_id: Vec<T> = Vec::new();
    for value in read_array_json(txn, name) {
        let Some(record) = T::normalize(&value) else {
            continue;
        };
        by_id.retain(|r| r.id() != record.id());
        by_id.push(record);
    }
    by_id
}

fn write_records<T: Record>(txn: &mut TransactionMut, name: &str, records: &[T]) {
    // `next`: id -> (record, json), in first-seen order, last value wins.
    let mut next: Vec<(T, Json)> = Vec::new();
    for record in records {
        let Some(normalized) = T::normalize(&record.to_json()) else {
            continue;
        };
        let json = normalized.to_json();
        match next.iter().position(|(r, _)| r.id() == normalized.id()) {
            Some(at) => next[at] = (normalized, json),
            None => next.push((normalized, json)),
        }
    }
    let array = txn.get_or_insert_array(name);
    let current: Vec<Json> = array.iter(&*txn).map(|v| out_json(v, &*txn)).collect();
    let mut kept: Vec<String> = Vec::new();
    let mut stored: Vec<(String, Map<String, Json>)> = Vec::new();
    let mut deletions: Vec<u32> = Vec::new();
    for (index, value) in current.iter().enumerate() {
        let id = record_id(value);
        let wanted = id.and_then(|id| next.iter().find(|(r, _)| r.id() == id));
        // An unknown entry is left alone: it may be a record a newer build understands.
        let (Some(id), Some(raw)) = (id, value.as_object()) else {
            continue;
        };
        if wanted.is_none() && T::normalize(value).is_none() {
            continue;
        }
        stored.push((id.to_owned(), raw.clone()));
        if let Some((_, json)) = wanted
            && !kept.iter().any(|k| k == id)
            && T::normalize(value).map(|r| r.to_json()).as_ref() == Some(json)
        {
            kept.push(id.to_owned());
            continue;
        }
        deletions.push(index as u32);
    }
    let insertions: Vec<Json> = next
        .iter()
        .filter(|(r, _)| !kept.iter().any(|k| k == r.id()))
        .map(
            |(record, json)| match stored.iter().rfind(|(id, _)| id == record.id()) {
                Some((_, raw)) => record.overlay(raw),
                None => json.clone(),
            },
        )
        .collect();
    if deletions.is_empty() && insertions.is_empty() {
        return;
    }
    for index in deletions.into_iter().rev() {
        array.remove(txn, index);
    }
    if !insertions.is_empty() {
        let at = array.len(&*txn);
        array.insert_range(
            txn,
            at,
            insertions.iter().map(json_to_any).collect::<Vec<_>>(),
        );
    }
}

pub fn read_writing_alternatives<T: ReadTxn>(txn: &T) -> Vec<WritingAlternative> {
    read_records(txn, WRITING_ALTERNATIVES_ARRAY)
}

pub fn write_writing_alternatives(txn: &mut TransactionMut, items: &[WritingAlternative]) {
    write_records(txn, WRITING_ALTERNATIVES_ARRAY, items);
}

pub fn read_writing_ghosts<T: ReadTxn>(txn: &T) -> Vec<WritingGhost> {
    read_records(txn, WRITING_GHOSTS_ARRAY)
}

pub fn write_writing_ghosts(txn: &mut TransactionMut, items: &[WritingGhost]) {
    write_records(txn, WRITING_GHOSTS_ARRAY, items);
}

pub fn read_writing_overflow<T: ReadTxn>(txn: &T) -> Vec<WritingOverflowItem> {
    read_records(txn, WRITING_OVERFLOW_ARRAY)
}

pub fn write_writing_overflow(txn: &mut TransactionMut, items: &[WritingOverflowItem]) {
    write_records(txn, WRITING_OVERFLOW_ARRAY, items);
}

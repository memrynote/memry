//! What a canvas scene points at and holds, read from Excalidraw JSON without
//! the library: Electron's `canvas/scene-refs.ts` (entity cards and the arrows
//! between them), `canvas/summary.ts` (what an agent reads) and
//! `canvas/elements.ts` (what an agent draws against), rule for rule.
//!
//! A card is a `rectangle` whose `customData` carries `{entityType, entityId}`.
//! A scene comes from a vault file or a peer, so every read is total: text that
//! is not JSON, JSON nested past `serde_json`'s recursion limit, a scene over
//! [`MAX_SCENE_BYTES`] and a scene with no `elements` array all read as empty.
//! Each read walks the elements a fixed number of times, and every output is
//! capped or bounded by the elements it came from.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::folder_paths::js_trim;

/// The entity types a card may name (`CANVAS_ENTITY_TYPES`,
/// `packages/contracts/src/canvas-api.ts:35`).
pub const CANVAS_ENTITY_TYPES: [&str; 5] = ["note", "task", "calendar_event", "project", "file"];

/// Largest scene these reads parse. Far above the sync cap, so every scene a
/// user can draw is read; a bigger file reads as empty rather than being
/// parsed into memory several times its size. Electron has no such bound.
pub const MAX_SCENE_BYTES: usize = 64 * 1024 * 1024;

/// Most text elements a summary returns (`MAX_SUMMARY_TEXTS`).
pub const MAX_SUMMARY_TEXTS: usize = 200;
/// Most text a summary returns, in UTF-16 code units (`MAX_SUMMARY_TEXT_CHARS`).
pub const MAX_SUMMARY_TEXT_CHARS: usize = 20_000;
/// Most elements an element read returns (`MAX_ELEMENT_VIEWS`).
pub const MAX_ELEMENT_VIEWS: usize = 1000;

/// One entity card's target.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanvasEntityRef {
    pub entity_type: String,
    pub entity_id: String,
}

/// One live arrow joining two different entities, oriented the way it points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasEntityEdge {
    pub arrow_id: String,
    pub source: CanvasEntityRef,
    pub target: CanvasEntityRef,
}

/// `CanvasSceneSummary`: the entities on a canvas and the text typed on it,
/// never the geometry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CanvasSceneSummary {
    pub items: Vec<CanvasEntityRef>,
    pub texts: Vec<String>,
    /// Live (non-deleted) elements.
    pub element_count: usize,
    /// Whether either text cap stopped collection.
    pub texts_truncated: bool,
}

/// `CanvasElementView` (`packages/contracts/src/canvas-draw.ts`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CanvasElementView {
    pub id: String,
    pub element_type: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub angle: Option<f64>,
    pub text: Option<String>,
    pub label: Option<String>,
    pub stroke_color: Option<String>,
    pub background_color: Option<String>,
    pub link: Option<String>,
    pub start_element_id: Option<String>,
    pub end_element_id: Option<String>,
    pub frame_id: Option<String>,
    pub name: Option<String>,
}

/// `CanvasSceneElements`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CanvasSceneElements {
    pub elements: Vec<CanvasElementView>,
    /// Live elements before the cap.
    pub element_count: usize,
    pub truncated: bool,
}

/// `extractEntityRefsFromScene`: the scene's cards, deduped by entity, in order.
pub fn entity_refs(scene: &str) -> Vec<CanvasEntityRef> {
    entity_refs_counted(scene, &mut 0)
}

/// `extractEntityEdgesFromScene`: every live arrow whose ends are bound to two
/// cards of different entities. An arrow whose only head is at its start points
/// the other way; heads on both ends or neither keep the drawing order.
pub fn entity_edges(scene: &str) -> Vec<CanvasEntityEdge> {
    entity_edges_counted(scene, &mut 0)
}

/// `summarizeScene`.
pub fn summarize(scene: &str) -> CanvasSceneSummary {
    summarize_counted(scene, &mut 0)
}

/// `readSceneElements`.
pub fn read_elements(scene: &str) -> CanvasSceneElements {
    read_elements_counted(scene, &mut 0)
}

/// Each `*_counted` read adds one to `visits` per element it looks at, so a
/// test can bound the walk without a clock.
pub(super) fn entity_refs_counted(scene: &str, visits: &mut usize) -> Vec<CanvasEntityRef> {
    let mut seen = HashSet::new();
    let mut refs = Vec::new();
    for element in &scene_elements(scene) {
        *visits += 1;
        if let Some(card) =
            card_ref(element).filter(|card| !is_deleted(element) && seen.insert(card.clone()))
        {
            refs.push(card);
        }
    }
    refs
}

pub(super) fn entity_edges_counted(scene: &str, visits: &mut usize) -> Vec<CanvasEntityEdge> {
    let elements = scene_elements(scene);
    let mut cards: HashMap<&str, CanvasEntityRef> = HashMap::new();
    for element in &elements {
        *visits += 1;
        if let (Some(card), Some(id)) =
            (card_ref(element), element.get("id").and_then(Value::as_str))
            && !is_deleted(element)
        {
            cards.insert(id, card);
        }
    }
    if cards.len() < 2 {
        return Vec::new();
    }
    let mut seen_arrows = HashSet::new();
    let mut edges = Vec::new();
    for element in &elements {
        *visits += 1;
        if element.get("type").and_then(Value::as_str) != Some("arrow") || is_deleted(element) {
            continue;
        }
        let Some(arrow_id) = non_empty(element.get("id")) else {
            continue;
        };
        if seen_arrows.contains(arrow_id) {
            continue;
        }
        let end = |key: &str| bound_element_id(element.get(key)).and_then(|id| cards.get(id));
        let (Some(start), Some(finish)) = (end("startBinding"), end("endBinding")) else {
            continue;
        };
        if start == finish {
            continue;
        }
        let head = |key: &str| element.get(key).is_some_and(|head| !head.is_null());
        let reversed = head("startArrowhead") && !head("endArrowhead");
        seen_arrows.insert(arrow_id);
        let (source, target) = if reversed {
            (finish, start)
        } else {
            (start, finish)
        };
        edges.push(CanvasEntityEdge {
            arrow_id: arrow_id.to_owned(),
            source: source.clone(),
            target: target.clone(),
        });
    }
    edges
}

pub(super) fn summarize_counted(scene: &str, visits: &mut usize) -> CanvasSceneSummary {
    let mut summary = CanvasSceneSummary::default();
    let mut seen = HashSet::new();
    let mut text_chars = 0;
    for element in &scene_elements(scene) {
        *visits += 1;
        if is_deleted(element) {
            continue;
        }
        summary.element_count += 1;
        if let Some(card) = card_ref(element) {
            if seen.insert(card.clone()) {
                summary.items.push(card);
            }
            continue;
        }
        if element.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = element.get("text").and_then(Value::as_str).map(js_trim) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let length = text.encode_utf16().count();
        if summary.texts.len() >= MAX_SUMMARY_TEXTS || text_chars + length > MAX_SUMMARY_TEXT_CHARS
        {
            summary.texts_truncated = true;
            continue;
        }
        summary.texts.push(text.to_owned());
        text_chars += length;
    }
    summary
}

pub(super) fn read_elements_counted(scene: &str, visits: &mut usize) -> CanvasSceneElements {
    let elements = scene_elements(scene);
    let mut labels: HashMap<&str, &str> = HashMap::new();
    for element in &elements {
        *visits += 1;
        if is_deleted(element) || element.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let (Some(container), Some(text)) = (
            non_empty(element.get("containerId")),
            non_empty(element.get("text")),
        ) {
            labels.insert(container, text);
        }
    }
    let mut read = CanvasSceneElements::default();
    for element in &elements {
        *visits += 1;
        if is_deleted(element) {
            continue;
        }
        read.element_count += 1;
        let (Some(id), Some(element_type)) =
            (non_empty(element.get("id")), non_empty(element.get("type")))
        else {
            continue;
        };
        // A caption is reported through its container, not twice.
        if element_type == "text" && non_empty(element.get("containerId")).is_some() {
            continue;
        }
        if read.elements.len() >= MAX_ELEMENT_VIEWS {
            continue;
        }
        read.elements
            .push(view(element, id, element_type, labels.get(id).copied()));
    }
    read.truncated =
        read.elements.len() >= MAX_ELEMENT_VIEWS && read.element_count > read.elements.len();
    read
}

fn view(
    element: &Map<String, Value>,
    id: &str,
    element_type: &str,
    label: Option<&str>,
) -> CanvasElementView {
    let text = |key: &str| non_empty(element.get(key)).map(str::to_owned);
    let number = |key: &str| element.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let custom = element.get("customData").and_then(Value::as_object);
    let entity = custom.and_then(|data| entity_of(data, |value| non_empty(Some(value))));
    // A box saved from a note's mind map keeps its href in `customData`.
    let mind_map_href = custom.and_then(|data| non_empty(data.get("memryHref")));
    CanvasElementView {
        id: id.to_owned(),
        element_type: element_type.to_owned(),
        x: number("x"),
        y: number("y"),
        width: number("width"),
        height: number("height"),
        entity_type: entity.as_ref().map(|card| card.entity_type.clone()),
        entity_id: entity.map(|card| card.entity_id),
        angle: element
            .get("angle")
            .and_then(Value::as_f64)
            .filter(|angle| *angle != 0.0),
        text: text("text"),
        label: label.map(str::to_owned),
        stroke_color: text("strokeColor"),
        background_color: text("backgroundColor"),
        link: text("link").or_else(|| mind_map_href.map(str::to_owned)),
        start_element_id: bound_element_id(element.get("startBinding")).map(str::to_owned),
        end_element_id: bound_element_id(element.get("endBinding")).map(str::to_owned),
        frame_id: text("frameId"),
        name: text("name"),
    }
}

/// The scene's element objects. Anything that is not an object reads as an
/// element with no fields, which every rule passes over.
fn scene_elements(scene: &str) -> Vec<Map<String, Value>> {
    if scene.is_empty() || scene.len() > MAX_SCENE_BYTES {
        return Vec::new();
    }
    let Ok(Value::Object(mut parsed)) = serde_json::from_str::<Value>(scene) else {
        return Vec::new();
    };
    let Some(Value::Array(elements)) = parsed.remove("elements") else {
        return Vec::new();
    };
    elements
        .into_iter()
        .map(|element| match element {
            Value::Object(fields) => fields,
            _ => Map::new(),
        })
        .collect()
}

/// `isDeleted === true`, strictly.
fn is_deleted(element: &Map<String, Value>) -> bool {
    element.get("isDeleted") == Some(&Value::Bool(true))
}

/// The card's entity, for a `rectangle` with a valid `customData` ref. Deleted
/// cards are each caller's to skip.
fn card_ref(element: &Map<String, Value>) -> Option<CanvasEntityRef> {
    if element.get("type").and_then(Value::as_str) != Some("rectangle") {
        return None;
    }
    entity_of(element.get("customData")?.as_object()?, Value::as_str)
}

/// `{entityType, entityId}` of a known type and a non-empty id. `entity_type`
/// reads the type: scene-refs and summary accept any string, elements only a
/// non-empty one, and the type list makes the difference moot.
fn entity_of(
    data: &Map<String, Value>,
    entity_type: impl Fn(&Value) -> Option<&str>,
) -> Option<CanvasEntityRef> {
    let kind = entity_type(data.get("entityType")?)?;
    let id = non_empty(data.get("entityId"))?;
    CANVAS_ENTITY_TYPES
        .contains(&kind)
        .then(|| CanvasEntityRef {
            entity_type: kind.to_owned(),
            entity_id: id.to_owned(),
        })
}

fn bound_element_id(binding: Option<&Value>) -> Option<&str> {
    non_empty(binding?.as_object()?.get("elementId"))
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests;

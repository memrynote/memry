//! Port of `packages/shared/src/link-card-marker.ts` and of the
//! `wiki-link-props.ts` helpers it reads: the `<!-- link-card:{…} -->` sidecar
//! line, the display settings of a wiki link that is the only content of its
//! paragraph.

use serde_json::{Map, Value as Json, json};

use super::block_colors::dotted_payload;
use super::block_colors::js_value::{is_record, js_parse, js_stringify, prop, spread_all};
use crate::markdown::frontmatter::js::js_trim;

/// `WikiLinkSize`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WikiLinkSize {
    None,
    Small,
    Medium,
}

impl WikiLinkSize {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Small => "small",
            Self::Medium => "medium",
        }
    }

    /// `isWikiLinkSize`, as a parse.
    fn from_json(value: &Json) -> Option<Self> {
        match value.as_str()? {
            "none" => Some(Self::None),
            "small" => Some(Self::Small),
            "medium" => Some(Self::Medium),
            _ => Option::None,
        }
    }
}

/// `Partial<WikiLinkDisplayProps>`: the settings a marker names.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LinkCardDisplay {
    pub size: Option<WikiLinkSize>,
    pub cover: Option<bool>,
    pub preview: Option<bool>,
}

impl LinkCardDisplay {
    /// The object the TypeScript builds: keys `size`, `cover`, `preview`, present ones only.
    pub fn to_json(self) -> Json {
        let mut map = Map::new();
        if let Some(size) = self.size {
            map.insert("size".to_owned(), json!(size.as_str()));
        }
        if let Some(cover) = self.cover {
            map.insert("cover".to_owned(), json!(cover));
        }
        if let Some(preview) = self.preview {
            map.insert("preview".to_owned(), json!(preview));
        }
        Json::Object(map)
    }

    fn is_empty(self) -> bool {
        self.size.is_none() && self.cover.is_none() && self.preview.is_none()
    }
}

/// `LINK_CARD_LINE_REGEX.test(line)`.
pub fn is_link_card_line(line: &str) -> bool {
    dotted_payload(line, "<!-- link-card:").is_some()
}

/// `wikiLinkMarkProps`: the marks of a `styles` object that are set, in the
/// order bold, italic, underline, strike, code, textColor, backgroundColor.
fn wiki_link_mark_props(styles: &Json) -> Map<String, Json> {
    let mut props = Map::new();
    for key in ["bold", "italic", "underline", "strike", "code"] {
        if prop(styles, key) == Some(&Json::Bool(true)) {
            props.insert(key.to_owned(), Json::Bool(true));
        }
    }
    for key in ["textColor", "backgroundColor"] {
        if let Some(Json::String(color)) = prop(styles, key)
            && color != "default"
        {
            props.insert(key.to_owned(), Json::String(color.clone()));
        }
    }
    props
}

fn is_wiki_link_node(item: &Json) -> bool {
    is_record(item)
        && prop(item, "type").and_then(Json::as_str) == Some("wikiLink")
        && prop(item, "props").is_some_and(is_record)
}

fn is_blank_text(item: &Json) -> bool {
    is_record(item)
        && prop(item, "type").and_then(Json::as_str) == Some("text")
        && prop(item, "text")
            .and_then(Json::as_str)
            .is_some_and(|text| js_trim(text).is_empty())
}

fn is_paragraph(block: &Json) -> bool {
    prop(block, "type").and_then(Json::as_str) == Some("paragraph")
}

/// The block's wiki link when it is a paragraph holding nothing else; runs of
/// only whitespace beside the link do not count.
fn sole_wiki_link_node(block: &Json) -> Option<Json> {
    if !is_paragraph(block) {
        return None;
    }
    let content = prop(block, "content")?.as_array()?;
    let mut links = content.iter().filter(|item| !is_blank_text(item));
    let only = links.next()?;
    if links.next().is_some() {
        return None;
    }
    is_wiki_link_node(only).then(|| only.clone())
}

/// `^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$`: the target and the optional alias, untrimmed.
fn parse_wiki_link_text(text: &str) -> Option<(&str, Option<&str>)> {
    let rest = text.strip_prefix("[[")?;
    let target_end = rest.find([']', '|'])?;
    let (target, rest) = rest.split_at(target_end);
    if target.is_empty() {
        return None;
    }
    if rest == "]]" {
        return Some((target, None));
    }
    let rest = rest.strip_prefix('|')?;
    let alias_end = rest.find(']')?;
    let (alias, tail) = rest.split_at(alias_end);
    (!alias.is_empty() && tail == "]]").then_some((target, Some(alias)))
}

/// The block's content when it is a paragraph whose text runs, all in one
/// style, read exactly `[[target]]` or `[[target|alias]]`.
fn promote_sole_wiki_link_text(block: &Json) -> Option<Json> {
    if !is_paragraph(block) {
        return None;
    }
    let content = prop(block, "content")?.as_array()?;
    if content.is_empty() {
        return None;
    }
    let mut texts = Vec::with_capacity(content.len());
    for run in content {
        if !is_record(run) || prop(run, "type").and_then(Json::as_str) != Some("text") {
            return None;
        }
        texts.push(prop(run, "text")?.as_str()?);
    }
    let empty = Json::Object(Map::new());
    let styles = prop(&content[0], "styles")
        .filter(|styles| is_record(styles))
        .unwrap_or(&empty);
    let style_text = |run: &Json| match prop(run, "styles") {
        None | Some(Json::Null) => "{}".to_owned(),
        Some(other) => js_stringify(other),
    };
    let wanted = js_stringify(styles);
    if content.iter().any(|run| style_text(run) != wanted) {
        return None;
    }
    let joined = texts.concat();
    let (target, alias) = parse_wiki_link_text(&joined)?;
    let target = js_trim(target);
    if target.is_empty() {
        return None;
    }
    let mut props = Map::new();
    props.insert("target".to_owned(), json!(target));
    props.insert("alias".to_owned(), json!(alias.map_or("", js_trim)));
    props.extend(wiki_link_mark_props(styles));
    Some(json!({"type": "wikiLink", "props": props}))
}

/// The marker line a block needs, or `None` when it is not a sole link or all defaults.
pub fn serialize_link_card_marker(block: &Json) -> Option<String> {
    let node = sole_wiki_link_node(block)?;
    let props = prop(&node, "props")?;
    let mut display = LinkCardDisplay::default();
    if let Some(size @ (WikiLinkSize::Small | WikiLinkSize::Medium)) =
        prop(props, "size").and_then(WikiLinkSize::from_json)
    {
        display.size = Some(size);
    }
    if prop(props, "cover") == Some(&Json::Bool(true)) {
        display.cover = Some(true);
    }
    if prop(props, "preview") == Some(&Json::Bool(true)) {
        display.preview = Some(true);
    }
    (!display.is_empty())
        .then(|| format!("<!-- link-card:{} -->", js_stringify(&display.to_json())))
}

/// Parse a marker line into the settings it names; `None` for anything that is
/// not a valid marker. An unrecognised extra key is ignored.
pub fn parse_link_card_marker(line: &str) -> Option<LinkCardDisplay> {
    let parsed = js_parse(dotted_payload(line, "<!-- link-card:")?)?;
    if !is_record(&parsed) {
        return None;
    }
    let mut display = LinkCardDisplay::default();
    if let Some(size) = prop(&parsed, "size") {
        display.size = Some(WikiLinkSize::from_json(size)?);
    }
    if let Some(cover) = prop(&parsed, "cover") {
        display.cover = Some(cover.as_bool()?);
    }
    if let Some(preview) = prop(&parsed, "preview") {
        display.preview = Some(preview.as_bool()?);
    }
    (!display.is_empty()).then_some(display)
}

/// Put parsed settings on the block's wiki link. A block that is not a
/// paragraph holding only one link is left as it is.
pub fn apply_link_card(block: &mut Json, display: LinkCardDisplay) {
    let Some(mut node) = sole_wiki_link_node(block).or_else(|| promote_sole_wiki_link_text(block))
    else {
        return;
    };
    let defaults = json!({"size": "none", "cover": false, "preview": false});
    let merged = {
        let current = prop(&node, "props").cloned().unwrap_or_default();
        spread_all(&[&current, &defaults, &display.to_json()])
    };
    if let Some(map) = node.as_object_mut() {
        map.insert("props".to_owned(), Json::Object(merged));
    }
    if let Some(map) = block.as_object_mut() {
        map.insert("content".to_owned(), Json::Array(vec![node]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_link_writes_no_marker() {
        let block = json!({
            "type": "paragraph", "props": {},
            "content": [{"type": "wikiLink", "props": {"target": "A"}}]
        });
        assert_eq!(serialize_link_card_marker(&block), None);
    }

    #[test]
    fn a_marker_claims_a_seeded_text_link() {
        let mut block = json!({
            "type": "paragraph", "props": {},
            "content": [{"type": "text", "text": "[[A|b]]", "styles": {"bold": true}}]
        });
        let display = parse_link_card_marker(r#"<!-- link-card:{"size":"small"} -->"#).unwrap();
        apply_link_card(&mut block, display);
        assert_eq!(
            block["content"],
            json!([{"type": "wikiLink", "props": {
                "target": "A", "alias": "b", "bold": true,
                "size": "small", "cover": false, "preview": false
            }}])
        );
    }
}

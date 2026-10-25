//! The `parse` functions of the block specs: what BlockNote's default blocks
//! and memry's overrides read from a pasted element (`rule.getAttrs` of the
//! `*` rules). Each returns `None` for `undefined` (the rule does not apply).

use yrs::Any;

use super::attrs::{Props, text};
use super::js::{js_number, js_parse_int, js_round};
use super::url::src_property;
use crate::markdown::bn::dom::{Dom, NodeId, Selector};
use crate::markdown::frontmatter::js::js_trim;

pub fn tag_is(dom: &Dom, id: NodeId, name: &str) -> bool {
    dom.node_name(id) == name
}

fn first_element_child_is_code(dom: &Dom, id: NodeId) -> Option<NodeId> {
    let code = dom.first_element_child(id)?;
    (dom.child_element_count(id) == 1 && tag_is(dom, code, "CODE")).then_some(code)
}

/// `parseDefaultProps`. A prop that is `undefined` is left out.
pub fn default_props(dom: &Dom, id: NodeId) -> Props {
    let style = dom.style(id);
    let mut props: Props = Vec::new();
    if let Some(value) = dom.attr(id, "data-background-color") {
        props.push(("backgroundColor", text(value)));
    } else if !style.get("background-color").is_empty() {
        props.push(("backgroundColor", text(style.get("background-color"))));
    }
    if let Some(value) = dom.attr(id, "data-text-color") {
        props.push(("textColor", text(value)));
    } else if !style.get("color").is_empty() {
        props.push(("textColor", text(style.get("color"))));
    }
    let align = style.get("text-align");
    if matches!(align, "left" | "center" | "right" | "justify") {
        props.push(("textAlignment", text(align)));
    }
    props
}

pub fn paragraph(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "P") || js_trim(&dom.text_content(id)).is_empty() {
        return None;
    }
    Some(default_props(dom, id))
}

pub fn heading(dom: &Dom, id: NodeId) -> Option<Props> {
    if tag_is(dom, id, "DETAILS") {
        let summary = dom.query_selector(id, &Selector::new(":scope > summary"))?;
        let heading = dom.query_selector(summary, &Selector::new("h1, h2, h3, h4, h5, h6"))?;
        let mut props = default_props(dom, heading);
        props.push(("level", Any::Number(level_of(dom, heading))));
        props.push(("isToggleable", Any::Bool(true)));
        return Some(props);
    }
    let level = match dom.node_name(id).as_str() {
        "H1" => 1.0,
        "H2" => 2.0,
        "H3" => 3.0,
        "H4" => 4.0,
        "H5" => 5.0,
        "H6" => 6.0,
        _ => return None,
    };
    let mut props = default_props(dom, id);
    props.push(("level", Any::Number(level)));
    Some(props)
}

/// `parseInt(heading.tagName[1])`.
fn level_of(dom: &Dom, heading: NodeId) -> f64 {
    dom.node_name(heading)
        .chars()
        .nth(1)
        .and_then(|c| c.to_digit(10))
        .map_or(f64::NAN, f64::from)
}

pub fn quote(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "BLOCKQUOTE") {
        return None;
    }
    Some(
        default_props(dom, id)
            .into_iter()
            .filter(|(name, _)| matches!(*name, "backgroundColor" | "textColor"))
            .collect(),
    )
}

pub fn divider(dom: &Dom, id: NodeId) -> Option<Props> {
    tag_is(dom, id, "HR").then(Vec::new)
}

/// `[[ ... ]]` of an HTML `width` property: the `unsigned long` conversion of
/// an `<img>`, `ToNumber` then modulo 2^32.
fn image_width(dom: &Dom, id: NodeId) -> Option<f64> {
    let width = js_number(dom.attr(id, "width")?);
    let width = if width.is_finite() {
        width.trunc().rem_euclid(4_294_967_296.0)
    } else {
        0.0
    };
    (width != 0.0).then_some(width)
}

/// A `<video>`'s `width`: "rules for parsing non-negative integers", 0 when
/// absent, malformed or above 2^31 - 1.
fn video_width(dom: &Dom, id: NodeId) -> Option<f64> {
    let value = dom.attr(id, "width")?;
    let trimmed = value.trim_start_matches([' ', '\t', '\n', '\u{0C}', '\r']);
    let (negative, rest) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || negative {
        return None;
    }
    let number: f64 = digits.parse().ok()?;
    (number != 0.0 && number <= 2_147_483_647.0).then_some(number)
}

/// The element-level props of a file block's media element.
#[derive(Clone, Copy)]
pub enum Media {
    Image,
    Video,
    Audio,
}

impl Media {
    fn tag(self) -> &'static str {
        match self {
            Media::Image => "IMG",
            Media::Video => "VIDEO",
            Media::Audio => "AUDIO",
        }
    }

    fn selector(self) -> &'static str {
        match self {
            Media::Image => "img",
            Media::Video => "video",
            Media::Audio => "audio",
        }
    }

    /// `parseImageElement`, `parseVideoElement`, `parseAudioElement`.
    fn element_props(self, dom: &Dom, id: NodeId) -> Props {
        let mut props: Props = Vec::new();
        if let Some(url) = src_property(dom.attr(id, "src")) {
            props.push(("url", Any::from(url)));
        }
        let width = match self {
            Media::Image => image_width(dom, id),
            Media::Video => video_width(dom, id),
            Media::Audio => return props,
        };
        if let Some(width) = width {
            props.push(("previewWidth", Any::Number(width)));
        }
        let name = match self {
            Media::Image => dom.attr(id, "alt"),
            _ => dom.attr(id, "data-name"),
        };
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            props.push(("name", text(name)));
        }
        props
    }
}

/// `imageParse`, `videoParse` and `audioParse`: the element itself, or a
/// `<figure>` holding it and a caption.
pub fn media(dom: &Dom, id: NodeId, kind: Media) -> Option<Props> {
    if tag_is(dom, id, kind.tag()) {
        // Ignore if parent figure has already been parsed.
        if dom.closest(id, &Selector::new("figure")).is_some() {
            return None;
        }
        let mut props = kind.element_props(dom, id);
        props.extend(
            default_props(dom, id)
                .into_iter()
                .filter(|(name, _)| *name == "backgroundColor"),
        );
        return Some(props);
    }
    if tag_is(dom, id, "FIGURE") {
        let target = dom.query_selector(id, &Selector::new(kind.selector()))?;
        let caption = dom
            .query_selector(id, &Selector::new("figcaption"))
            .map(|c| dom.text_content(c));
        let mut props = kind.element_props(dom, target);
        props.extend(
            default_props(dom, id)
                .into_iter()
                .filter(|(name, _)| *name == "backgroundColor"),
        );
        if let Some(caption) = caption {
            props.push(("caption", Any::from(caption)));
        }
        return Some(props);
    }
    None
}

/// `toWidth` of the inline image: `Math.round(Number(value))` when it is a
/// positive finite number.
pub fn to_width(value: f64) -> f64 {
    let width = js_round(value);
    if width.is_finite() && width > 0.0 {
        width
    } else {
        0.0
    }
}

/// `parseInlineImageAlt`: a trailing `|<digits>` is a width.
pub fn parse_inline_image_alt(raw: &str) -> (String, f64) {
    if let Some((alt, digits)) = raw.rsplit_once('|')
        && !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !alt.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
    {
        let width = to_width(js_number(digits));
        if width > 0.0 {
            return (alt.to_owned(), width);
        }
    }
    (raw.to_owned(), 0.0)
}

/// `image`, with memry's `withImageWidthInAlt`: `name|300` is name `name`,
/// width 300 unless the element carries a real width.
pub fn image(dom: &Dom, id: NodeId) -> Option<Props> {
    let mut props = media(dom, id, Media::Image)?;
    let Some(Any::String(name)) = props
        .iter()
        .find(|(n, _)| *n == "name")
        .map(|(_, v)| v.clone())
    else {
        return Some(props);
    };
    let (alt, width) = parse_inline_image_alt(&name);
    if width == 0.0 {
        return Some(props);
    }
    let has_width = props
        .iter()
        .find(|(n, _)| *n == "previewWidth")
        .is_some_and(|(_, v)| matches!(v, Any::Number(w) if to_width(*w) > 0.0));
    props.retain(|(n, _)| *n != "name");
    props.push(("name", Any::from(alt)));
    if !has_width {
        props.retain(|(n, _)| *n != "previewWidth");
        props.push(("previewWidth", Any::Number(width)));
    }
    Some(props)
}

/// `parsePreCode`'s language: `data-language`, else the first `language-*`
/// class. `None` is `undefined`.
fn pre_code_language(dom: &Dom, code: NodeId) -> Option<String> {
    if let Some(language) = dom.attr(code, "data-language").filter(|l| !l.is_empty()) {
        return Some(language.to_owned());
    }
    dom.attr(code, "class")
        .unwrap_or("")
        .split(' ')
        .find(|name| name.starts_with("language-"))
        .map(|name| name["language-".len()..].to_owned())
}

/// `codeBlock`, with memry's `parseUntaggedFenceAsUntagged`: no language is `''`.
pub fn code_block(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "PRE") {
        return None;
    }
    let code = first_element_child_is_code(dom, id)?;
    Some(vec![(
        "language",
        Any::from(pre_code_language(dom, code).unwrap_or_default()),
    )])
}

/// `parseDiagramCodeElement`: a `<pre><code>` tagged `mermaid`.
pub fn diagram(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "PRE") {
        return None;
    }
    let code = first_element_child_is_code(dom, id)?;
    (pre_code_language(dom, code).as_deref() == Some("mermaid")).then(Vec::new)
}

fn in_list(dom: &Dom, li: NodeId, list: &str) -> bool {
    let Some(parent) = dom.parent_element(li) else {
        return false;
    };
    tag_is(dom, parent, list)
        || (tag_is(dom, parent, "DIV")
            && dom
                .parent_element(parent)
                .is_some_and(|p| tag_is(dom, p, list)))
}

pub fn bullet_list_item(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "LI") {
        return None;
    }
    if dom.parent_element(id).is_none() || in_list(dom, id, "UL") {
        return Some(default_props(dom, id));
    }
    // Orphan `<li>` (no <ul>/<ol> ancestor): a bulletListItem.
    if dom.closest(id, &Selector::new("ul, ol")).is_none() {
        return Some(default_props(dom, id));
    }
    None
}

/// `checkListItem`. Its `input` branch compares `tagName` with lower-case
/// `"input"`, which an HTML element never has, so only `<li>` is parsed.
pub fn check_list_item(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "LI") || !in_list(dom, id, "UL") {
        return None;
    }
    let checkbox = dom.query_selector(id, &Selector::new("input[type=checkbox]"))?;
    let mut props = default_props(dom, id);
    props.push(("checked", Any::Bool(dom.has_attr(checkbox, "checked"))));
    Some(props)
}

pub fn numbered_list_item(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "LI") || !in_list(dom, id, "OL") {
        return None;
    }
    // `start` is read from the direct parent, a `<div>` wrapper included.
    let parent = dom.parent_element(id)?;
    let start = match dom.attr(parent, "start").filter(|s| !s.is_empty()) {
        Some(value) => js_parse_int(value),
        None => 1.0,
    };
    let mut props = default_props(dom, id);
    if dom.previous_element_sibling(id).is_none() && start != 1.0 {
        props.push(("start", Any::Number(start)));
    }
    Some(props)
}

/// `isInsideTableCell`.
fn in_table_cell(dom: &Dom, id: NodeId) -> bool {
    dom.closest(id, &Selector::new("td, th")).is_some()
}

pub fn inline_image(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "IMG") || !in_table_cell(dom, id) {
        return None;
    }
    let src = js_trim(dom.attr(id, "src").unwrap_or(""));
    if src.is_empty() {
        return None;
    }
    let (alt, alt_width) = parse_inline_image_alt(dom.attr(id, "alt").unwrap_or(""));
    let attribute = to_width(js_number(dom.attr(id, "width").unwrap_or("")));
    Some(vec![
        ("src", text(src)),
        ("alt", Any::from(alt)),
        (
            "width",
            Any::Number(if attribute > 0.0 {
                attribute
            } else {
                alt_width
            }),
        ),
    ])
}

pub fn inline_checkbox(dom: &Dom, id: NodeId) -> Option<Props> {
    if !tag_is(dom, id, "INPUT") || !in_table_cell(dom, id) {
        return None;
    }
    // `input.type` is the attribute lower-cased when it is a known type.
    let checkbox = dom
        .attr(id, "type")
        .is_some_and(|t| t.eq_ignore_ascii_case("checkbox"));
    checkbox.then(|| vec![("checked", Any::Bool(dom.has_attr(id, "checked")))])
}

fn non_empty_attr<'a>(dom: &'a Dom, id: NodeId, name: &str) -> &'a str {
    dom.attr(id, name).filter(|v| !v.is_empty()).unwrap_or("")
}

pub fn hash_tag(dom: &Dom, id: NodeId) -> Option<Props> {
    let tag = js_trim(dom.attr(id, "data-hash-tag")?);
    if tag.is_empty() {
        return None;
    }
    Some(vec![
        ("tag", text(tag)),
        (
            "color",
            text(js_trim(non_empty_attr(dom, id, "data-hash-tag-color"))),
        ),
        (
            "icon",
            text(js_trim(non_empty_attr(dom, id, "data-hash-tag-icon"))),
        ),
    ])
}

pub fn link_mention(dom: &Dom, id: NodeId) -> Option<Props> {
    if !dom.has_attr(id, "data-link-mention") {
        return None;
    }
    let url = non_empty_attr(dom, id, "data-url");
    if url.is_empty() {
        return None;
    }
    Some(vec![
        ("url", text(url)),
        ("domain", text(non_empty_attr(dom, id, "data-domain"))),
        ("title", text(non_empty_attr(dom, id, "data-title"))),
        ("favicon", text(non_empty_attr(dom, id, "data-favicon"))),
        ("siteName", text(non_empty_attr(dom, id, "data-site-name"))),
    ])
}

pub fn date_mention(dom: &Dom, id: NodeId) -> Option<Props> {
    if !dom.has_attr(id, "data-date-mention") {
        return None;
    }
    let anchor_id = non_empty_attr(dom, id, "data-anchor-id");
    let date_iso = non_empty_attr(dom, id, "data-date-iso");
    if anchor_id.is_empty() || date_iso.is_empty() {
        return None;
    }
    let or = |name: &str, default: &'static str| match non_empty_attr(dom, id, name) {
        "" => text(default),
        value => text(value),
    };
    Some(vec![
        ("anchorId", text(anchor_id)),
        ("dateISO", text(date_iso)),
        (
            "hasTime",
            Any::Bool(dom.attr(id, "data-has-time") == Some("true")),
        ),
        ("dateFormat", or("data-date-format", "relative")),
        ("remind", or("data-remind", "none")),
        ("timeFormat", or("data-time-format", "system")),
    ])
}

/// The textColor and backgroundColor styles' `parse`: a `<span>` with the
/// inline style, whose value is the style's `stringValue`.
pub fn span_style(dom: &Dom, id: NodeId, property: &str) -> Option<Props> {
    if !tag_is(dom, id, "SPAN") {
        return None;
    }
    let style = dom.style(id);
    let value = style.get(property);
    (!value.is_empty()).then(|| vec![("stringValue", text(value))])
}

#[cfg(test)]
#[path = "blocks_tests.rs"]
mod tests;

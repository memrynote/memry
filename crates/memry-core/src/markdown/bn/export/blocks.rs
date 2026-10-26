//! `toExternalHTML` of every block type: BlockNote's defaults and the memry
//! server specs (`packages/editor-schema/src/blocks/server-specs.ts`).

use serde_json::Value as Json;

use super::{Ret, err, table, truthy};
use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::convert::ConvertError;
use crate::markdown::schema::blocks::callout::callout_marker;
use crate::markdown::schema::blocks::embeds::{YOUTUBE_EMBED_DEFAULT_ALT, whiteboard_url};
use crate::markdown::schema::blocks::math::serialize_math_block;
use crate::markdown::shared::task_block::serialize_task_block;

fn el(dom: &mut Dom, name: &str, attrs: &[(&str, &str)]) -> NodeId {
    let id = dom.create_element(name);
    for (k, v) in attrs {
        dom.set_attr(id, k, v);
    }
    id
}

fn text_el(dom: &mut Dom, name: &str, text: &str) -> NodeId {
    let id = dom.create_element(name);
    let t = dom.create_text(text);
    dom.append_child(id, t);
    id
}

/// `props[name]` as a string, `default` when absent.
fn pstr<'a>(props: &'a Json, name: &str, default: &'a str) -> &'a str {
    props.get(name).and_then(Json::as_str).unwrap_or(default)
}

/// A boolean prop that defaults to true (`showPreview`).
fn pbool_default_true(props: &Json) -> bool {
    props.get("showPreview").is_none_or(|v| truthy(Some(v)))
}

/// The block's DOM, or an error for a type the schema does not know.
pub(super) fn block_dom(
    dom: &mut Dom,
    ty: &str,
    props: &Json,
    block: &Json,
) -> Result<Ret, ConvertError> {
    Ok(match ty {
        "paragraph" => {
            let p = dom.create_element("p");
            Ret::with_content(p, p)
        }
        "heading" => heading(dom, props),
        "quote" => {
            let q = dom.create_element("blockquote");
            Ret::with_content(q, q)
        }
        "codeBlock" => {
            let language = pstr(props, "language", "javascript");
            pre_code(dom, &format!("language-{language}"), language)
        }
        "diagram" => pre_code(dom, "language-mermaid", "mermaid"),
        "divider" => Ret::leaf(dom.create_element("hr")),
        "bulletListItem" | "numberedListItem" | "toggleListItem" => {
            let li = dom.create_element("li");
            let p = dom.create_element("p");
            dom.append_child(li, p);
            Ret::with_content(li, p)
        }
        "checkListItem" => {
            let li = dom.create_element("li");
            let checkbox = checkbox(dom, truthy(props.get("checked")));
            let p = dom.create_element("p");
            dom.append_child(li, checkbox);
            dom.append_child(li, p);
            Ret::with_content(li, p)
        }
        "taskBlock" => {
            let ul = dom.create_element("ul");
            let li = dom.create_element("li");
            dom.append_child(ul, li);
            let cb = checkbox(dom, truthy(props.get("checked")));
            dom.append_child(li, cb);
            let line = serialize_task_block(&with_task_defaults(props));
            let label = line
                .strip_prefix("- [ ] ")
                .or_else(|| line.strip_prefix("- [x] "))
                .unwrap_or(&line);
            let span = text_el(dom, "span", label);
            dom.append_child(li, span);
            Ret::leaf(ul)
        }
        "table" => table::table_dom(dom, block)?,
        "image" => media(dom, props, Media::Image),
        "video" => media(dom, props, Media::Video),
        "audio" => media(dom, props, Media::Audio),
        // The marker is a comment node, which `htmlToMarkdown` drops.
        "file" => Ret::leaf(dom.create_element("div")),
        "callout" => callout(dom, props, block),
        "youtubeEmbed" => image_embed(
            dom,
            pstr(props, "videoUrl", ""),
            props
                .get("alt")
                .and_then(Json::as_str)
                .unwrap_or(YOUTUBE_EMBED_DEFAULT_ALT),
        ),
        "bookmark" => image_embed(dom, pstr(props, "url", ""), "bookmark"),
        "whiteboard" => {
            let canvas = pstr(props, "canvasId", "");
            if canvas.is_empty() {
                Ret::leaf(dom.create_element("div"))
            } else {
                image_embed(dom, &whiteboard_url(canvas), "whiteboard")
            }
        }
        "mathBlock" => math(dom, pstr(props, "latex", "")),
        "columnList" | "column" => {
            let div = dom.create_element("div");
            Ret::with_content(div, div)
        }
        other => return Err(err(format!("block type {other} not in the schema"))),
    })
}

fn with_task_defaults(props: &Json) -> Json {
    let mut map = serde_json::Map::new();
    for (k, v) in [
        ("taskId", Json::from("")),
        ("title", Json::from("")),
        ("checked", Json::from(false)),
        ("parentTaskId", Json::from("")),
    ] {
        map.insert(k.to_owned(), props.get(k).cloned().unwrap_or(v));
    }
    Json::Object(map)
}

fn checkbox(dom: &mut Dom, checked: bool) -> NodeId {
    let input = el(dom, "input", &[("type", "checkbox")]);
    if checked {
        dom.set_attr(input, "checked", "");
    }
    input
}

fn heading(dom: &mut Dom, props: &Json) -> Ret {
    let level = props
        .get("level")
        .and_then(Json::as_f64)
        .filter(|l| (1.0..=6.0).contains(l))
        .map_or(1, |l| l as u8);
    let h = dom.create_element(&format!("h{level}"));
    if truthy(props.get("isToggleable")) {
        let details = el(dom, "details", &[("open", "")]);
        let summary = dom.create_element("summary");
        dom.append_child(summary, h);
        dom.append_child(details, summary);
        return Ret {
            dom: details,
            content: Some(h),
            children: Some(details),
        };
    }
    Ret::with_content(h, h)
}

fn pre_code(dom: &mut Dom, class: &str, language: &str) -> Ret {
    let pre = dom.create_element("pre");
    let code = el(
        dom,
        "code",
        &[("class", class), ("data-language", language)],
    );
    dom.append_child(pre, code);
    Ret::with_content(pre, code)
}

/// `imageEmbedDom`: a `div` holding the `img` that `htmlToMarkdown` writes as `![alt](url)`.
fn image_embed(dom: &mut Dom, url: &str, alt: &str) -> Ret {
    let div = dom.create_element("div");
    let img = el(dom, "img", &[("src", url), ("alt", alt)]);
    dom.append_child(div, img);
    Ret::leaf(div)
}

/// `calloutDom`: `[!type]`, a `<br>` unless the content is an empty array, and
/// the content span, all in one paragraph.
fn callout(dom: &mut Dom, props: &Json, block: &Json) -> Ret {
    let quote = dom.create_element("blockquote");
    let p = dom.create_element("p");
    let ty = match pstr(props, "type", "info") {
        "" => "info",
        t => t,
    };
    let fold = props.get("fold").and_then(Json::as_str);
    let marker = dom.create_text(&callout_marker(ty, fold));
    dom.append_child(p, marker);
    let empty_array = block
        .get("content")
        .and_then(Json::as_array)
        .is_some_and(Vec::is_empty);
    if !empty_array {
        let br = dom.create_element("br");
        dom.append_child(p, br);
    }
    let span = dom.create_element("span");
    dom.append_child(p, span);
    dom.append_child(quote, p);
    Ret::with_content(quote, span)
}

/// `mathBlockDom`: the `$` fence as one paragraph of text lines and `<br>`s.
fn math(dom: &mut Dom, latex: &str) -> Ret {
    let p = dom.create_element("p");
    for (i, line) in serialize_math_block(latex).split('\n').enumerate() {
        if i > 0 {
            let br = dom.create_element("br");
            dom.append_child(p, br);
        }
        let t = dom.create_text(line);
        dom.append_child(p, t);
    }
    Ret::leaf(p)
}

#[derive(Clone, Copy, PartialEq)]
enum Media {
    Image,
    Video,
    Audio,
}

impl Media {
    fn tag(self) -> &'static str {
        match self {
            Media::Image => "img",
            Media::Video => "video",
            Media::Audio => "audio",
        }
    }
}

/// `image`, `video` and `audio` `toExternalHTML`, and memry's `withImageWidthInAlt`.
fn media(dom: &mut Dom, props: &Json, kind: Media) -> Ret {
    let url = pstr(props, "url", "");
    if url.is_empty() {
        return Ret::leaf(dom.create_element(kind.tag()));
    }
    let name = pstr(props, "name", "");
    let shown = if name.is_empty() { url } else { name };
    let preview = pbool_default_true(props);
    let element = if preview {
        let e = el(dom, kind.tag(), &[("src", url)]);
        if kind == Media::Image {
            // withImageWidthInAlt rewrites the alt of the exported `<img>`.
            dom.set_attr(
                e,
                "alt",
                &super::inline::image_block_alt(name, props.get("previewWidth")),
            );
        }
        e
    } else {
        let a = el(dom, "a", &[("href", url)]);
        let t = dom.create_text(shown);
        dom.append_child(a, t);
        a
    };
    let caption = pstr(props, "caption", "");
    if caption.is_empty() {
        // createBlockSpec puts the non-default props on a bare element as
        // `data-*`; `htmlToMarkdown` reads `data-name` of a video.
        if preview && kind == Media::Video && !name.is_empty() {
            dom.set_attr(element, "data-name", name);
        }
        return Ret::leaf(element);
    }
    if preview {
        let figure = dom.create_element("figure");
        dom.append_child(figure, element);
        let fc = text_el(dom, "figcaption", caption);
        dom.append_child(figure, fc);
        Ret::leaf(figure)
    } else {
        let wrapper = dom.create_element("div");
        dom.append_child(wrapper, element);
        let p = text_el(dom, "p", caption);
        dom.append_child(wrapper, p);
        Ret::leaf(wrapper)
    }
}

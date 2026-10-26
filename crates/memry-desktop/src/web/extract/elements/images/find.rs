//! Finding the main image and the caption of a container (`findMainImage`, `findCaption`,
//! `extractUniqueCaptionContent`, `hasMeaningfulCaption`), and turning an image-like element
//! into an `img` (`processImageElement`).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::elements::rule::{attr, attr_or_empty};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::tag_lower;
use crate::web::extract::utils::js::{trim, utf16_len};

use super::is_base64_placeholder;
use super::srcset::{apply_srcset_to_image, is_svg_data_url, is_valid_image_url};

/// `filenamePattern`: `/^[\w\-\.\/\\]+\.(jpg|jpeg|png|gif|webp|svg)$/i`.
static FILENAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9_\-./\\]+(?i-u:\.(?:jpg|jpeg|png|gif|webp|svg))$")
        .expect("static pattern")
});
/// `datePattern`: `/^\d{4}-\d{2}-\d{2}$/`.
static DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").expect("static pattern"));
/// `/^\d+$/`.
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+$").expect("static pattern"));

const CAPTION_SELECTORS: &str = "[class*=\"caption\"], [class*=\"description\"], [class*=\"alt\"], [class*=\"title\"], [class*=\"credit\"], [class*=\"text\"], [class*=\"post-thumbnail-text\"], [class*=\"image-caption\"], [class*=\"photo-caption\"], [aria-label], [title]";

/// `isImageElement(element)`.
pub fn is_image_element(doc: &Document, el: NodeId) -> bool {
    matches!(
        tag_lower(doc, el).as_str(),
        "img" | "video" | "picture" | "source"
    )
}

/// `containsImage(element)`.
pub fn contains_image(doc: &Document, el: NodeId) -> Result<bool, ExtractError> {
    Ok(is_image_element(doc, el)
        || !doc
            .query_selector_all(el, "img, video, picture, source")?
            .is_empty())
}

/// `textContent?.trim()`.
fn trimmed_text(doc: &Document, el: NodeId) -> String {
    trim(&doc.text_content(el).unwrap_or_default()).to_string()
}

/// `findMainImage(element)`.
pub fn find_main_image(doc: &Document, element: NodeId) -> Result<Option<NodeId>, ExtractError> {
    if is_image_element(doc, element) {
        return Ok(Some(element));
    }
    if let Some(picture) = doc.query_selector(element, "picture")? {
        return Ok(Some(picture));
    }
    let imgs = doc.query_selector_all(element, "img")?;
    for &img in &imgs {
        let src = attr_or_empty(doc, img, "src");
        let alt = attr_or_empty(doc, img, "alt");
        if is_svg_data_url(&src) || is_base64_placeholder(&src) {
            continue;
        }
        if trim(&alt).is_empty() && imgs.len() > 1 {
            continue;
        }
        return Ok(Some(img));
    }
    if let Some(video) = doc.query_selector(element, "video")? {
        return Ok(Some(video));
    }
    if let Some(source) = doc.query_selector(element, "source")? {
        return Ok(Some(source));
    }
    doc.query_selector(element, "img, picture, source, video")
}

/// `findCaption(element)`. The alt-text caption is a new, detached `div`.
pub fn find_caption(doc: &mut Document, element: NodeId) -> Result<Option<NodeId>, ExtractError> {
    if let Some(figcaption) = doc.query_selector(element, "figcaption")? {
        return Ok(Some(figcaption));
    }
    for candidate in doc.query_selector_all(element, CAPTION_SELECTORS)? {
        if is_image_element(doc, candidate) {
            continue;
        }
        if !trimmed_text(doc, candidate).is_empty() {
            return Ok(Some(candidate));
        }
    }
    if let Some(img) = doc.query_selector(element, "img")?
        && doc.has_attribute(img, "alt")
    {
        let alt = attr_or_empty(doc, img, "alt");
        if !trim(&alt).is_empty() {
            let caption = doc.create_element("div");
            doc.set_text_content(caption, &alt)?;
            return Ok(Some(caption));
        }
    }
    if let Some(parent) = doc.parent_element(element) {
        for sibling in doc.children(parent) {
            if sibling == element {
                continue;
            }
            let has_caption_class = doc.class_list(sibling).iter().any(|c| {
                c.contains("caption")
                    || c.contains("credit")
                    || c.contains("text")
                    || c.contains("description")
            });
            if has_caption_class && !trimmed_text(doc, sibling).is_empty() {
                return Ok(Some(sibling));
            }
        }
    }
    let imgs = doc.query_selector_all(element, "img")?;
    for &img in &imgs {
        if doc.parent_element(img).is_none() {
            continue;
        }
        let mut next = doc.next_element_sibling(img);
        while let Some(n) = next {
            if matches!(
                doc.tag_name(n).as_deref(),
                Some("EM" | "STRONG" | "SPAN" | "I" | "B" | "SMALL" | "CITE")
            ) && !trimmed_text(doc, n).is_empty()
            {
                return Ok(Some(n));
            }
            next = doc.next_element_sibling(n);
        }
    }
    for &img in &imgs {
        let Some(parent) = doc.parent_element(img) else {
            continue;
        };
        for text_el in doc.query_selector_all(parent, "em, strong, span, i, b, small, cite")? {
            if text_el == img {
                continue;
            }
            if !trimmed_text(doc, text_el).is_empty() {
                return Ok(Some(text_el));
            }
        }
    }
    Ok(None)
}

/// `extractUniqueCaptionContent(caption)`: the distinct text nodes joined by a space, or the
/// caption's `innerHTML` when it holds no text.
pub fn extract_unique_caption_content(doc: &Document, caption: NodeId) -> String {
    fn process(doc: &Document, node: NodeId, texts: &mut Vec<String>, seen: &mut HashSet<String>) {
        match doc.node(node).kind {
            NodeKind::Text(_) => {
                let text = trim(&doc.text_content(node).unwrap_or_default()).to_string();
                if !text.is_empty() && seen.insert(text.clone()) {
                    texts.push(text);
                }
            }
            NodeKind::Element(_) => {
                for child in doc.child_nodes(node) {
                    process(doc, child, texts, seen);
                }
            }
            _ => {}
        }
    }
    let mut texts = Vec::new();
    let mut seen = HashSet::new();
    for child in doc.child_nodes(caption) {
        process(doc, child, &mut texts, &mut seen);
    }
    if texts.is_empty() {
        doc.inner_html(caption)
    } else {
        texts.join(" ")
    }
}

/// `hasMeaningfulCaption(caption)`.
pub fn has_meaningful_caption(doc: &Document, caption: NodeId) -> bool {
    let text = trimmed_text(doc, caption);
    if utf16_len(&text) < 10 || text.starts_with("http://") || text.starts_with("https://") {
        return false;
    }
    !(FILENAME.is_match(&text) || DIGITS.is_match(&text) || DATE.is_match(&text))
}

/// `copyAttributesExcept(source, target, excludeAttrs)`.
fn copy_attributes_except(doc: &mut Document, source: NodeId, target: NodeId, exclude: &[&str]) {
    let attrs: Vec<_> = doc
        .attributes(source)
        .iter()
        .filter(|a| !exclude.contains(&a.name.as_str()))
        .map(|a| (a.name.clone(), a.value.clone()))
        .collect();
    for (name, value) in attrs {
        doc.set_attribute(target, &name, &value);
    }
}

/// `processImgElement`: a placeholder `img` whose sibling `source`s hold `data-srcset` becomes a
/// new `img` with the `data-src`; any other `img` is cloned.
fn process_img_element(doc: &mut Document, element: NodeId) -> Result<NodeId, ExtractError> {
    let src = attr_or_empty(doc, element, "src");
    if (is_base64_placeholder(&src) || is_svg_data_url(&src))
        && let Some(parent) = doc.parent_element(element)
    {
        let has_data_srcset = doc
            .query_selector_all(parent, "source")?
            .into_iter()
            .any(|s| {
                doc.has_attribute(s, "data-srcset")
                    && !attr_or_empty(doc, s, "data-srcset").is_empty()
            });
        if has_data_srcset {
            let new_img = doc.create_element("img");
            if let Some(data_src) = attr(doc, element, "data-src").filter(|s| !s.is_empty())
                && !is_svg_data_url(&data_src)
            {
                doc.set_attribute(new_img, "src", &data_src);
            }
            copy_attributes_except(doc, element, new_img, &["src"]);
            return Ok(new_img);
        }
    }
    Ok(doc.clone_node(element, true))
}

/// `processSourceElement`: a `source` becomes an `img` with its srcset and the attributes of a
/// real sibling `img`.
fn process_source_element(doc: &mut Document, element: NodeId) -> Result<NodeId, ExtractError> {
    let new_img = doc.create_element("img");
    if let Some(srcset) = attr(doc, element, "srcset").filter(|s| !s.is_empty()) {
        apply_srcset_to_image(doc, &srcset, new_img);
    }
    let Some(parent) = doc.parent_element(element) else {
        return Ok(new_img);
    };
    let mut good = None;
    for img in doc.query_selector_all(parent, "img")? {
        let src = attr_or_empty(doc, img, "src");
        if !is_base64_placeholder(&src) && !is_svg_data_url(&src) && !src.is_empty() {
            good = Some(img);
            break;
        }
    }
    let fill_src = |doc: &mut Document, from: NodeId, name: &str| {
        let current = attr_or_empty(doc, new_img, "src");
        if (!doc.has_attribute(new_img, "src") || !is_valid_image_url(&current))
            && let Some(value) = attr(doc, from, name).filter(|s| !s.is_empty())
            && is_valid_image_url(&value)
        {
            doc.set_attribute(new_img, "src", &value);
        }
    };
    if let Some(img) = good {
        copy_attributes_except(doc, img, new_img, &["src", "srcset"]);
        fill_src(doc, img, "src");
    } else if let Some(data_img) = doc.query_selector(parent, "img[data-src]")? {
        copy_attributes_except(doc, data_img, new_img, &["src", "srcset"]);
        fill_src(doc, data_img, "data-src");
    }
    Ok(new_img)
}

/// `processImageElement(element, doc)`.
pub fn process_image_element(doc: &mut Document, element: NodeId) -> Result<NodeId, ExtractError> {
    match tag_lower(doc, element).as_str() {
        "img" => process_img_element(doc, element),
        "picture" => match doc.query_selector(element, "img")? {
            Some(inside) => process_img_element(doc, inside),
            None => Ok(doc.clone_node(element, true)),
        },
        "source" => process_source_element(doc, element),
        _ => Ok(doc.clone_node(element, true)),
    }
}

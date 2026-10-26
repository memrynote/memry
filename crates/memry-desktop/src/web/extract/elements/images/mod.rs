//! `dist/elements/images.js`: picture, `uni-image-full-width`, lazy-loaded images, spans and
//! figures that wrap an image with a caption.

mod find;
mod srcset;

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::constants::BLOCK_LEVEL_ELEMENTS;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::{tag_lower, transfer_content};
use crate::web::extract::utils::js::{trim, utf16_len};
use crate::web::extract::utils::json;

use super::rule::{Rule, attr, attr_or_empty};
use find::{
    contains_image, extract_unique_caption_content, find_caption, find_main_image,
    has_meaningful_caption, process_image_element,
};
use srcset::{
    apply_srcset_to_image, extract_first_url_from_srcset, has_image_extension, is_src_like,
    is_srcset_like, is_svg_data_url, is_valid_image_url, select_best_source,
};

/// `b64DataUrlRegex`.
static B64_DATA_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^data:image/([^;]+);base64,").expect("static pattern"));
/// `absoluteUrlPattern`.
static ABSOLUTE_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https?://").expect("static pattern"));

pub const RULES: &[Rule] = &[
    Rule {
        selector: "picture",
        fast_check: None,
        transform: picture,
    },
    Rule {
        selector: "uni-image-full-width",
        fast_check: None,
        transform: uni_image_full_width,
    },
    Rule {
        selector: "img[data-src], img[data-srcset], img[loading=\"lazy\"], img.lazy, img.lazyload, img[src^=\"data:image/svg+xml\"]",
        fast_check: None,
        transform: lazy_image,
    },
    Rule {
        selector: "span:has(img)",
        fast_check: None,
        transform: span_with_image,
    },
    Rule {
        selector: "figure, p:has([class*=\"caption\"])",
        fast_check: None,
        transform: figure,
    },
];

/// `isBase64Placeholder(src)`: a base64 image data URL whose payload is under 133 characters
/// (about 100 bytes), unless it is an SVG, which stays meaningful at any size.
pub fn is_base64_placeholder(src: &str) -> bool {
    let Some(caps) = B64_DATA_URL.captures(src) else {
        return false;
    };
    if &caps[1] == "svg+xml" {
        return false;
    }
    let prefix = caps.get(0).map_or(0, |m| utf16_len(m.as_str()));
    utf16_len(src) - prefix < 133
}

fn picture(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let sources = doc.query_selector_all(el, "source")?;
    let Some(img) = doc.query_selector(el, "img")? else {
        if let Some(best) = select_best_source(doc, &sources)
            && let Some(srcset) = attr(doc, best, "srcset").filter(|s| !s.is_empty())
        {
            let new_img = doc.create_element("img");
            apply_srcset_to_image(doc, &srcset, new_img);
            doc.replace_children(el, &[new_img])?;
        }
        return Ok(el);
    };
    let mut best_srcset = None;
    let mut best_src = None;
    if !sources.is_empty()
        && let Some(best) = select_best_source(doc, &sources)
    {
        best_srcset = attr(doc, best, "srcset").filter(|s| !s.is_empty());
        if let Some(srcset) = &best_srcset {
            best_src = extract_first_url_from_srcset(srcset);
        }
    }
    if let Some(srcset) = &best_srcset {
        doc.set_attribute(img, "srcset", srcset);
    }
    match best_src.filter(|s| !s.is_empty() && is_valid_image_url(s)) {
        Some(src) => doc.set_attribute(img, "src", &src),
        None => {
            let current = attr_or_empty(doc, img, "src");
            if !doc.has_attribute(img, "src") || !is_valid_image_url(&current) {
                let own = attr_or_empty(doc, img, "srcset");
                let from = if own.is_empty() {
                    best_srcset.unwrap_or_default()
                } else {
                    own
                };
                if let Some(first) = extract_first_url_from_srcset(&from)
                    && is_valid_image_url(&first)
                {
                    doc.set_attribute(img, "src", &first);
                }
            }
        }
    }
    for source in sources {
        doc.remove(source);
    }
    Ok(el)
}

fn uni_image_full_width(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let figure = doc.create_element("figure");
    let img = doc.create_element("img");
    let Some(original) = doc.query_selector(el, "img")? else {
        return Ok(figure);
    };
    let mut best_src = attr(doc, original, "src");
    if let Some(data_loading) = attr(doc, original, "data-loading").filter(|s| !s.is_empty()) {
        // Invalid JSON, or a `desktop` that is not a string, throws in JS and is skipped.
        if let Ok(value) = json::parse(&data_loading)
            && let Some(desktop) = value.get("desktop").and_then(|d| d.as_str())
            && is_valid_image_url(desktop)
        {
            best_src = Some(desktop.to_string());
        }
    }
    match best_src.filter(|s| !s.is_empty() && is_valid_image_url(s)) {
        Some(src) => doc.set_attribute(img, "src", &src),
        None => return Ok(figure),
    }
    let mut alt = attr(doc, original, "alt").filter(|s| !s.is_empty());
    if alt.is_none() {
        alt = attr(doc, el, "alt-text").filter(|s| !s.is_empty());
    }
    if let Some(alt) = alt {
        doc.set_attribute(img, "alt", &alt);
    }
    doc.append_child(figure, img)?;
    if let Some(figcaption_el) = doc.query_selector(el, "figcaption")? {
        let text = trim(&doc.text_content(figcaption_el).unwrap_or_default()).to_string();
        if utf16_len(&text) > 5 {
            let figcaption = doc.create_element("figcaption");
            match doc.query_selector(figcaption_el, ".rich-text p")? {
                Some(rich) => transfer_content(doc, rich, figcaption)?,
                None => doc.set_text_content(figcaption, &text)?,
            }
            doc.append_child(figure, figcaption)?;
        }
    }
    Ok(figure)
}

/// `hasBetterImageSource(element)`.
fn has_better_image_source(doc: &Document, el: NodeId) -> bool {
    if doc.has_attribute(el, "data-src") || doc.has_attribute(el, "data-srcset") {
        return true;
    }
    doc.attributes(el)
        .iter()
        .any(|a| a.name != "src" && has_image_extension(&a.value))
}

fn lazy_image(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let src = attr_or_empty(doc, el, "src");
    if (is_base64_placeholder(&src) || is_svg_data_url(&src)) && has_better_image_source(doc, el) {
        doc.remove_attribute(el, "src");
    }
    if let Some(data_src) = attr(doc, el, "data-src").filter(|s| !s.is_empty())
        && attr_or_empty(doc, el, "src").is_empty()
    {
        doc.set_attribute(el, "src", &data_src);
    }
    if let Some(data_srcset) = attr(doc, el, "data-srcset").filter(|s| !s.is_empty())
        && attr_or_empty(doc, el, "srcset").is_empty()
    {
        doc.set_attribute(el, "srcset", &data_srcset);
    }
    // `el.attributes` is live and a new attribute is inserted at the front, so an index loop that
    // re-reads the list visits what JS visits.
    let mut i = 0;
    while i < doc.attributes(el).len() {
        let a = &doc.attributes(el)[i];
        let (name, value) = (a.name.clone(), a.value.clone());
        i += 1;
        if matches!(name.as_str(), "src" | "srcset" | "alt") {
            continue;
        }
        if value.starts_with('{') || value.starts_with('[') {
            continue;
        }
        if is_srcset_like(&value) {
            doc.set_attribute(el, "srcset", &value);
        } else if is_src_like(&value) {
            let current = attr_or_empty(doc, el, "src");
            if !ABSOLUTE_URL.is_match(&current) || ABSOLUTE_URL.is_match(&value) {
                doc.set_attribute(el, "src", &value);
            }
        }
    }
    doc.class_list_remove(el, &["lazy", "lazyload"]);
    doc.remove_attribute(el, "data-ll-status");
    doc.remove_attribute(el, "data-src");
    doc.remove_attribute(el, "data-srcset");
    doc.remove_attribute(el, "loading");
    Ok(el)
}

/// `createFigureWithCaption(image, caption, doc)`: a clone of the image, then the caption.
fn create_figure_with_caption(
    doc: &mut Document,
    image: NodeId,
    caption: NodeId,
) -> Result<NodeId, ExtractError> {
    let figure = doc.create_element("figure");
    let copy = doc.clone_node(image, true);
    doc.append_child(figure, copy)?;
    let figcaption = doc.create_element("figcaption");
    let content = extract_unique_caption_content(doc, caption);
    let fragment = doc.parse_fragment(&content);
    doc.append_child(figcaption, fragment)?;
    doc.append_child(figure, figcaption)?;
    Ok(figure)
}

fn span_with_image(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    Ok(try_span_with_image(doc, el).unwrap_or(el))
}

fn try_span_with_image(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    if !contains_image(doc, el)? {
        return Ok(el);
    }
    // A span with block children is a content container, not an image wrapper.
    for child in doc.children(el) {
        if BLOCK_LEVEL_ELEMENTS.contains(&tag_lower(doc, child).as_str()) {
            return Ok(el);
        }
    }
    let Some(img) = find_main_image(doc, el)? else {
        return Ok(el);
    };
    let caption = find_caption(doc, el)?;
    let processed = process_image_element(doc, img)?;
    match caption {
        Some(caption) if has_meaningful_caption(doc, caption) => {
            let figure = create_figure_with_caption(doc, processed, caption)?;
            if doc.parent_node(caption).is_some() {
                doc.remove(caption);
            }
            Ok(figure)
        }
        _ => Ok(processed),
    }
}

fn figure(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    Ok(try_figure(doc, el).unwrap_or(el))
}

fn try_figure(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    if !contains_image(doc, el)? {
        return Ok(el);
    }
    let Some(img) = find_main_image(doc, el)? else {
        return Ok(el);
    };
    let caption = find_caption(doc, el)?;
    match caption {
        Some(caption) if has_meaningful_caption(doc, caption) => {
            let image = match find_main_image(doc, el)? {
                Some(current) => current,
                None => process_image_element(doc, img)?,
            };
            create_figure_with_caption(doc, image, caption)
        }
        _ => Ok(el),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders() {
        assert!(is_base64_placeholder(
            "data:image/gif;base64,R0lGODlhAQABAAAAACw="
        ));
        assert!(!is_base64_placeholder(
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
        ));
        assert!(!is_base64_placeholder("https://x.test/a.png"));
        let at = |n: usize| format!("data:image/png;base64,{}", "A".repeat(n));
        assert!(is_base64_placeholder(&at(132)));
        assert!(!is_base64_placeholder(&at(133)));
    }
}

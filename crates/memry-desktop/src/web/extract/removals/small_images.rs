//! Port of `dist/removals/small-images.js`: icons and tracking pixels by their declared size.
//!
//! `getComputedStyle` and `getBoundingClientRect` are browser-only in Defuddle and linkedom is
//! never a browser, so only the attribute, inline style, viewBox and srcset hints are read.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::images::is_base64_placeholder;
use crate::web::extract::elements::math::base::looks_like_latex;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{
    WS, WS_BODY, is_js_whitespace, parse_float, parse_int, split_runs,
};

static STYLE_WIDTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("width{WS}*:{WS}*([0-9]+)")).expect("static pattern"));
static STYLE_HEIGHT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("height{WS}*:{WS}*([0-9]+)")).expect("static pattern"));
/// `URL_WIDTH_PATTERN`: width hints in CDN URLs: `?w=48`, `&width=48`, `/w:48/`, `/width:48/`.
static URL_WIDTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:width[=:/]|[/,?&]w[_:=])([0-9]+)").expect("static pattern"));
/// `/(\S+)\s+1x/`.
static ONE_X: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("([^{WS_BODY}]+){WS}+1x")).expect("static pattern"));

const MIN_DIMENSION: f64 = 33.0;

/// The identifiers `findSmallImages` collected: a JS `Set<string>`, kept in insertion order.
#[derive(Debug, Default, Clone)]
pub struct SmallImages {
    order: Vec<String>,
    lookup: HashSet<String>,
}

impl SmallImages {
    pub fn insert(&mut self, id: String) {
        if self.lookup.insert(id.clone()) {
            self.order.push(id);
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.lookup.contains(id)
    }

    /// The identifiers in the order the set holds them.
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.order.iter().map(String::as_str)
    }
}

fn attr(doc: &Document, el: NodeId, name: &str) -> String {
    doc.get_attribute(el, name)
        .map(|v| v.into_owned())
        .unwrap_or_default()
}

fn is_tag(doc: &Document, el: NodeId, tag: &str) -> bool {
    doc.local_name(el)
        .is_some_and(|n| n.eq_ignore_ascii_case(tag))
}

/// `getElementIdentifier(element)`: `None` stands for `null`.
pub fn get_element_identifier(doc: &Document, el: NodeId) -> Option<String> {
    let is_svg = is_tag(doc, el, "svg");
    if is_tag(doc, el, "img") {
        let data_src = attr(doc, el, "data-src");
        if !data_src.is_empty() {
            return Some(format!("src:{data_src}"));
        }
        let src = attr(doc, el, "src");
        let srcset = attr(doc, el, "srcset");
        let data_srcset = attr(doc, el, "data-srcset");
        if !src.is_empty() {
            return Some(format!("src:{src}"));
        }
        if !srcset.is_empty() {
            return Some(format!("srcset:{srcset}"));
        }
        if !data_srcset.is_empty() {
            return Some(format!("srcset:{data_srcset}"));
        }
    }
    let id = doc.id_attr(el);
    let class_name = doc.class_name(el);
    let view_box = if is_svg {
        attr(doc, el, "viewBox")
    } else {
        String::new()
    };
    if !id.is_empty() {
        return Some(format!("id:{id}"));
    }
    if !view_box.is_empty() {
        return Some(format!("viewBox:{view_box}"));
    }
    if !class_name.is_empty() {
        return Some(format!("class:{class_name}"));
    }
    None
}

/// `parseInt(...) || 0`.
fn int_or_zero(s: &str) -> f64 {
    parse_int(s).unwrap_or(0) as f64
}

fn style_hint(re: &Regex, style: &str) -> f64 {
    re.captures(style).map_or(0.0, |c| int_or_zero(&c[1]))
}

/// `findSmallImages(doc)`: `img` and `svg` elements declared smaller than 33 in a dimension.
pub fn find_small_images(doc: &Document, root: NodeId) -> Result<SmallImages, ExtractError> {
    let mut small = SmallImages::default();
    for el in doc.query_selector_all(root, "img, svg")? {
        let attr_width = int_or_zero(&attr(doc, el, "width"));
        let attr_height = int_or_zero(&attr(doc, el, "height"));
        let is_svg = is_tag(doc, el, "svg");
        let (mut view_box_width, mut view_box_height) = (0.0, 0.0);
        if is_svg {
            let view_box = attr(doc, el, "viewBox");
            if !view_box.is_empty() {
                let parts = split_runs(&view_box, |c| is_js_whitespace(c) || c == ',');
                if parts.len() == 4 {
                    view_box_width = parse_float(parts[2]).filter(|n| *n != 0.0).unwrap_or(0.0);
                    view_box_height = parse_float(parts[3]).filter(|n| *n != 0.0).unwrap_or(0.0);
                }
            }
        }
        let style = attr(doc, el, "style");
        let style_width = style_hint(&STYLE_WIDTH, &style);
        let style_height = style_hint(&STYLE_HEIGHT, &style);

        let mut widths: Vec<f64> = [attr_width, style_width, view_box_width]
            .into_iter()
            .filter(|d| *d > 0.0)
            .collect();
        let heights: Vec<f64> = [attr_height, style_height, view_box_height]
            .into_iter()
            .filter(|d| *d > 0.0)
            .collect();
        // CDN icons: a 1x srcset entry at 32px or less.
        if widths.is_empty() && heights.is_empty() && is_tag(doc, el, "img") {
            let srcset = attr(doc, el, "srcset");
            if let Some(one_x) = ONE_X.captures(&srcset) {
                let url_width = URL_WIDTH
                    .captures(&one_x[1])
                    .map_or(0.0, |c| int_or_zero(&c[1]));
                if url_width > 0.0 {
                    widths.push(url_width);
                }
            }
        }
        if widths.is_empty() && heights.is_empty() {
            continue;
        }
        let effective_width = widths.iter().copied().fold(f64::INFINITY, f64::min);
        let effective_height = heights.iter().copied().fold(f64::INFINITY, f64::min);
        if effective_width < MIN_DIMENSION || effective_height < MIN_DIMENSION {
            if is_tag(doc, el, "img") {
                if looks_like_latex(&attr(doc, el, "alt")) {
                    continue;
                }
                if doc.class_list_contains(el, "latex") || doc.class_list_contains(el, "tex") {
                    continue;
                }
                if !attr(doc, el, "data-latex").is_empty() || !attr(doc, el, "data-math").is_empty()
                {
                    continue;
                }
            }
            if let Some(identifier) = get_element_identifier(doc, el) {
                small.insert(identifier);
            }
        }
    }
    Ok(small)
}

/// `removeSmallImages(doc, smallImages)`.
pub fn remove_small_images(
    doc: &mut Document,
    root: NodeId,
    small: &SmallImages,
) -> Result<(), ExtractError> {
    for tag in ["img", "svg"] {
        for el in doc.get_elements_by_tag_name(root, tag) {
            if tag == "img" {
                let src = attr(doc, el, "src");
                let has_alt_src = [
                    "srcset",
                    "data-src",
                    "data-srcset",
                    "data-lazy-src",
                    "data-original",
                ]
                .iter()
                .any(|name| !attr(doc, el, name).is_empty());
                // Broken images, and base64 placeholders nothing replaces. An image inside a
                // `picture` is resolved from its `source` later, so it stays.
                if src.is_empty() && !has_alt_src {
                    doc.remove(el);
                    continue;
                }
                if !has_alt_src
                    && doc.closest(el, "picture")?.is_none()
                    && is_base64_placeholder(&src)
                {
                    doc.remove(el);
                    continue;
                }
            }
            if let Some(identifier) = get_element_identifier(doc, el)
                && small.contains(&identifier)
            {
                doc.remove(el);
            }
        }
    }
    Ok(())
}

//! The image passes of `Defuddle` (`dist/defuddle.js`): attribute-name normalization, noscript
//! promotion before the scripts go, duplicate removal after URLs are resolved, and the cover
//! image that the metadata already holds.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{is_js_whitespace, parse_float, trim};

fn attr(doc: &Document, el: NodeId, name: &str) -> String {
    doc.get_attribute(el, name)
        .map(|v| v.into_owned())
        .unwrap_or_default()
}

fn is_real_src(src: &str) -> bool {
    !src.is_empty() && !src.starts_with("data:")
}

/// `_normalizeAttributes(body)`: React SSR writes `srcSet`, which linkedom keeps verbatim.
pub(super) fn normalize_attributes(doc: &mut Document, body: NodeId) -> Result<(), ExtractError> {
    for el in doc.query_selector_all(body, "img, source")? {
        if let Some(value) = doc.get_attribute(el, "srcSet").map(|v| v.into_owned()) {
            doc.remove_attribute(el, "srcSet");
            doc.set_attribute(el, "srcset", &value);
        }
    }
    Ok(())
}

/// `_resolveNoscriptImages(body)`: the real image of a lazy loader lives in a `<noscript>`
/// sibling (Next.js renders a tiny base64 gif as `src`).
pub(super) fn resolve_noscript_images(
    doc: &mut Document,
    body: NodeId,
) -> Result<(), ExtractError> {
    for noscript in doc.query_selector_all(body, "noscript")? {
        let mut noscript_img = doc.query_selector(noscript, "img")?;
        if noscript_img.is_none() {
            let mut html = doc.inner_html(noscript);
            if !html.contains("<img") {
                html = doc.text_content(noscript).unwrap_or_default();
            }
            if !html.contains("<img") {
                continue;
            }
            let fragment = doc.parse_fragment(&html);
            noscript_img = doc.query_selector(fragment, "img")?;
        }
        let Some(noscript_img) = noscript_img else {
            continue;
        };
        let real_src = attr(doc, noscript_img, "src");
        if !is_real_src(&real_src) {
            continue;
        }
        let alt = doc
            .get_attribute(noscript_img, "alt")
            .map(|v| v.into_owned());
        let Some(parent) = doc.parent_element(noscript) else {
            continue;
        };

        let mut matched = false;
        for img in doc.query_selector_all(parent, ":scope > img")? {
            if !attr(doc, img, "src").starts_with("data:") {
                continue;
            }
            // A non-empty alt text must match, or unrelated images would be swapped.
            let Some(alt) = alt.as_deref().filter(|a| !a.is_empty()) else {
                continue;
            };
            if doc.get_attribute(img, "alt").as_deref() != Some(alt) {
                continue;
            }
            doc.set_attribute(img, "src", &real_src);
            let srcset = attr(doc, noscript_img, "srcset");
            if !srcset.is_empty() {
                doc.set_attribute(img, "srcset", &srcset);
            }
            matched = true;
            break;
        }

        // No sibling to fix: promote the noscript image, but only in a lazy-loading wrapper
        // (not a tracking pixel) and only when no hydrated image exists.
        if !matched && is_lazy_image_context(doc, noscript)? {
            let container = doc.closest(noscript, "figure")?.unwrap_or(parent);
            let mut has_real = false;
            for img in doc.query_selector_all(container, "img")? {
                if doc.closest(img, "noscript")?.is_some() {
                    continue;
                }
                if is_real_src(&attr(doc, img, "src")) {
                    has_real = true;
                    break;
                }
            }
            if !has_real {
                let promoted = doc.clone_node(noscript_img, true);
                doc.insert_before(parent, promoted, Some(noscript))?;
            }
        }
    }
    Ok(())
}

/// `_isLazyImageContext(noscript)`.
fn is_lazy_image_context(doc: &Document, noscript: NodeId) -> Result<bool, ExtractError> {
    if doc.closest(noscript, "figure")?.is_some() {
        return Ok(true);
    }
    let Some(parent) = doc.parent_element(noscript) else {
        return Ok(false);
    };
    for sibling in doc.children(parent) {
        if sibling != noscript && doc.class_name(sibling).to_lowercase().contains("lazy") {
            return Ok(true);
        }
    }
    let class = doc.class_name(parent).to_lowercase();
    Ok(["image", "img", "picture", "photo", "media"]
        .iter()
        .any(|word| class.contains(word)))
}

/// `_normalizeSrc(url)`: no protocol and no query string, for loose comparison.
fn normalize_src(url: &str) -> &str {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    rest.split('?').next().unwrap_or(rest)
}

static URL_WIDTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:width[=:/]|[/,?&]w[_:=])([0-9]+)").expect("static pattern"));

/// `Defuddle._urlWidth(img)`.
fn url_width(doc: &Document, img: NodeId) -> f64 {
    URL_WIDTH
        .captures(&attr(doc, img, "src"))
        .and_then(|c| c[1].parse::<f64>().ok())
        .unwrap_or(0.0)
}

/// `_pickBestImage(a, b)`: a `srcset` image, then one in a `<picture>`, then the wider URL hint.
fn pick_best_image(doc: &Document, a: NodeId, b: NodeId) -> Result<NodeId, ExtractError> {
    let tier = |img: NodeId| -> Result<u8, ExtractError> {
        Ok(if !attr(doc, img, "srcset").is_empty() {
            2
        } else if doc.closest(img, "picture")?.is_some() {
            1
        } else {
            0
        })
    };
    let (tier_a, tier_b) = (tier(a)?, tier(b)?);
    if tier_a != tier_b {
        return Ok(if tier_a > tier_b { a } else { b });
    }
    let (width_a, width_b) = (url_width(doc, a), url_width(doc, b));
    if width_a != width_b {
        return Ok(if width_a > width_b { a } else { b });
    }
    Ok(a)
}

/// `_keepBestImage(group)`.
fn keep_best_image(doc: &mut Document, group: &[NodeId]) -> Result<(), ExtractError> {
    let mut best = group[0];
    for &next in &group[1..] {
        let winner = pick_best_image(doc, best, next)?;
        doc.remove(if winner == best { next } else { best });
        best = winner;
    }
    Ok(())
}

/// `_noVisibleContentBetween(a, b)`: only whitespace and wrapper markup sits between them.
fn no_visible_content_between(doc: &Document, a: NodeId, b: NodeId) -> bool {
    let next = |node: NodeId| -> Option<NodeId> {
        if let Some(child) = doc.first_child(node) {
            return Some(child);
        }
        let mut n = Some(node);
        while let Some(c) = n {
            if let Some(sibling) = doc.next_sibling(c) {
                return Some(sibling);
            }
            n = doc.parent_node(c);
        }
        None
    };
    let mut node = next(a);
    while let Some(n) = node {
        if n == b {
            break;
        }
        if matches!(doc.node(n).kind, NodeKind::Text(_))
            && !trim(&doc.text_content(n).unwrap_or_default()).is_empty()
        {
            return false;
        }
        node = next(n);
    }
    true
}

/// `_deduplicateImages(body)`: the same image twice from reader mode or lazy-load hydration.
pub(super) fn deduplicate_images(doc: &mut Document, body: NodeId) -> Result<(), ExtractError> {
    for figure in doc.query_selector_all(body, "figure")? {
        let mut figure_imgs = Vec::new();
        for img in doc.query_selector_all(figure, "img")? {
            if doc.closest(img, "noscript")?.is_none() && doc.parent_element(img).is_some() {
                figure_imgs.push(img);
            }
        }
        if figure_imgs.len() < 2 {
            continue;
        }
        // Grouped by alt text; images without alt share one group.
        let mut groups: Vec<(Option<String>, Vec<NodeId>)> = Vec::new();
        for img in figure_imgs {
            if !is_real_src(&attr(doc, img, "src")) {
                continue;
            }
            let alt = trim(&attr(doc, img, "alt")).to_string();
            let key = Some(alt).filter(|a| !a.is_empty());
            match groups.iter_mut().find(|(k, _)| *k == key) {
                Some((_, group)) => group.push(img),
                None => groups.push((key, vec![img])),
            }
        }
        for (key, group) in groups {
            if group.len() < 2 {
                continue;
            }
            // The same src with alt text is a legitimate repeat.
            let first_src = doc.get_attribute(group[0], "src").map(|v| v.into_owned());
            if key.is_some()
                && group
                    .iter()
                    .all(|&img| doc.get_attribute(img, "src").map(|v| v.into_owned()) == first_src)
            {
                continue;
            }
            keep_best_image(doc, &group)?;
        }
    }

    // Outside figures: a placeholder or low-res copy right beside the real one. Distinct images
    // with generic alt text, separated by text, are real content (#286).
    let imgs = doc.query_selector_all(body, "img")?;
    for i in 0..imgs.len().saturating_sub(1) {
        let img = imgs[i];
        if doc.parent_element(img).is_none()
            || doc.closest(img, "noscript")?.is_some()
            || doc.closest(img, "figure")?.is_some()
        {
            continue;
        }
        let alt = trim(&attr(doc, img, "alt")).to_string();
        let src = attr(doc, img, "src");
        if alt.is_empty() || !is_real_src(&src) {
            continue;
        }
        let other = imgs[i + 1];
        if doc.parent_element(other).is_none()
            || doc.closest(other, "noscript")?.is_some()
            || doc.closest(other, "figure")?.is_some()
            || trim(&attr(doc, other, "alt")) != alt
        {
            continue;
        }
        let other_src = attr(doc, other, "src");
        if !is_real_src(&other_src) || other_src == src {
            continue;
        }
        if !no_visible_content_between(doc, img, other) {
            continue;
        }
        keep_best_image(doc, &[img, other])?;
    }

    // Lightbox: `<a href="full.jpg"><img src="thumb.jpg"></a><img src="full.jpg">`.
    for img in doc.query_selector_all(body, "img")? {
        let Some(parent) = doc.parent_element(img) else {
            continue;
        };
        if doc.closest(img, "a, figure, noscript")?.is_some() {
            continue;
        }
        let src = attr(doc, img, "src");
        if !is_real_src(&src) {
            continue;
        }
        let normalized = normalize_src(&src).to_string();
        for link in doc.query_selector_all(parent, ":scope > a[href]")? {
            if doc.query_selector(link, "img")?.is_none() {
                continue;
            }
            if normalized == normalize_src(&attr(doc, link, "href")) {
                doc.remove(img);
                break;
            }
        }
    }
    Ok(())
}

static SRCSET_WIDTH_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([^\n\r\u{2028}\u{2029}]+?)[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+([0-9]+(?:\.[0-9]+)?)w")
        .expect("static pattern")
});
static CDN_WIDTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",w_[0-9]+").expect("static"));
static CDN_CROP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r",c_[A-Za-z0-9_]+").expect("static"));

/// `_getLargestImageSrc(img)`: the widest `srcset` entry (URLs may hold commas, so entries end
/// at width descriptors), without CDN width and crop constraints.
fn largest_image_src(doc: &Document, img: NodeId) -> String {
    let srcset = attr(doc, img, "srcset");
    if srcset.is_empty() {
        return attr(doc, img, "src");
    }
    let mut best_url = String::new();
    let mut best_width = 0.0;
    let mut last_end = 0;
    for entry in SRCSET_WIDTH_ENTRY.captures_iter(&srcset) {
        let whole = entry.get(0).expect("group 0");
        let mut url = trim(&entry[1]).to_string();
        if last_end > 0 {
            url = strip_leading_comma(&url);
        }
        last_end = whole.end();
        let width = parse_float(&entry[2]).unwrap_or(0.0);
        if !url.is_empty() && width > best_width {
            best_width = width;
            best_url = url;
        }
    }
    let url = if best_url.is_empty() {
        attr(doc, img, "src")
    } else {
        best_url
    };
    let url = CDN_WIDTH.replace_all(&url, "");
    CDN_CROP.replace_all(&url, "").into_owned()
}

/// `url.replace(/^,\s*/, '')`.
pub(super) fn strip_leading_comma(url: &str) -> String {
    match url.strip_prefix(',') {
        Some(rest) => rest.trim_start_matches(is_js_whitespace).to_string(),
        None => url.to_string(),
    }
}

/// `_removeCoverImage(body, metadataImage)`: drops the content image that is the metadata image
/// and returns its best `srcset` URL. A captioned figure is intentional content and stays.
pub(super) fn remove_cover_image(
    doc: &mut Document,
    body: NodeId,
    metadata_image: &str,
) -> Result<Option<String>, ExtractError> {
    if metadata_image.is_empty() {
        return Ok(None);
    }
    let meta_norm = normalize_src(metadata_image);
    for img in doc.query_selector_all(body, "img")? {
        let src = attr(doc, img, "src");
        if !is_real_src(&src) || normalize_src(&src) != meta_norm {
            continue;
        }
        let best = largest_image_src(doc, img);
        if let Some(figure) = doc.closest(img, "figure")?
            && doc.query_selector(figure, "figcaption")?.is_some()
        {
            return Ok(Some(best));
        }
        doc.remove(img);
        return Ok(Some(best));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_src_drops_scheme_and_query() {
        assert_eq!(normalize_src("https://a.com/x.jpg?w=1"), "a.com/x.jpg");
        assert_eq!(normalize_src("http://a.com/x"), "a.com/x");
        assert_eq!(normalize_src("/x.jpg?a"), "/x.jpg");
    }

    #[test]
    fn leading_comma() {
        assert_eq!(strip_leading_comma(", \n/a.jpg"), "/a.jpg");
        assert_eq!(strip_leading_comma("/a,b"), "/a,b");
    }
}

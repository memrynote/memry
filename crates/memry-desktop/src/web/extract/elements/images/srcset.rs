//! The URL and srcset helpers of `dist/elements/images.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::rule::attr;
use crate::web::extract::utils::js::{WS, WS_BODY, parse_float, parse_int, trim};

/// JS `.`: anything but a line terminator.
const LINE: &str = r"[^\n\r\x{2028}\x{2029}]";

/// `/\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i`.
static IMAGE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i-u:\.(?:jpg|jpeg|png|webp|gif|avif))(?:\?{LINE}*)?$"
    ))
    .expect("static pattern")
});
/// `/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i`.
static IMAGE_EXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i-u:\.(?:jpg|jpeg|png|webp|gif))(?:\?{LINE}*)?$"
    ))
    .expect("static pattern")
});
/// `/\s(\d+)w/`.
static WIDTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{WS}([0-9]+)w")).expect("static pattern"));
/// `/dpr=(\d+(?:\.\d+)?)/`.
static DPR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"dpr=([0-9]+(?:\.[0-9]+)?)").expect("static pattern"));
/// `/(.+?)\s+(\d+(?:\.\d+)?[wx])/g`.
static SRCSET_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"({LINE}+?){WS}+[0-9]+(?:\.[0-9]+)?[wx]")).expect("static pattern")
});
/// `/^([^\s]+)/`.
static FIRST_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^([^{WS_BODY}]+)")).expect("static pattern"));
/// `srcsetPattern`: `/\.(jpg|jpeg|png|webp)\s+\d/`.
static SRCSET_LIKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"\.(?:jpg|jpeg|png|webp){WS}+[0-9]")).expect("static pattern")
});
/// `srcPattern`: `/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/`.
static SRC_LIKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^{WS}*[^{WS_BODY}]+\.(?:jpg|jpeg|png|webp)[^{WS_BODY}]*{WS}*$"
    ))
    .expect("static pattern")
});
/// `/^,\s*/`.
static LEADING_COMMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^,{WS}*")).expect("static pattern"));

pub fn is_srcset_like(value: &str) -> bool {
    SRCSET_LIKE.is_match(value)
}

pub fn is_src_like(value: &str) -> bool {
    SRC_LIKE.is_match(value)
}

/// `/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(value)`.
pub fn has_image_extension(value: &str) -> bool {
    IMAGE_EXT.is_match(value)
}

/// `isSvgDataUrl(src)`.
pub fn is_svg_data_url(src: &str) -> bool {
    src.starts_with("data:image/svg+xml")
}

/// `isValidImageUrl(src)`.
pub fn is_valid_image_url(src: &str) -> bool {
    if src.starts_with("data:") || trim(src).is_empty() {
        return false;
    }
    IMAGE_URL.is_match(src) || src.contains("image") || src.contains("img") || src.contains("photo")
}

/// `extractFirstUrlFromSrcset(srcset)`.
pub fn extract_first_url_from_srcset(srcset: &str) -> Option<String> {
    let trimmed = trim(srcset);
    if trimmed.is_empty() {
        return None;
    }
    // `lastIndex > 0` after the first match: later entries drop the comma of the previous one.
    for (n, caps) in SRCSET_ENTRY.captures_iter(trimmed).enumerate() {
        let mut url = trim(&caps[1]).to_string();
        if n > 0 {
            url = LEADING_COMMA.replace(&url, "").into_owned();
        }
        if url.is_empty() || is_svg_data_url(&url) {
            continue;
        }
        return Some(url);
    }
    FIRST_TOKEN
        .captures(trimmed)
        .map(|c| c[1].to_string())
        .filter(|u| !is_svg_data_url(u))
}

/// `selectBestSource(sources)`.
pub fn select_best_source(doc: &Document, sources: &[NodeId]) -> Option<NodeId> {
    match sources {
        [] => return None,
        [only] => return Some(*only),
        _ => {}
    }
    if let Some(&default) = sources.iter().find(|&&s| !doc.has_attribute(s, "media")) {
        return Some(default);
    }
    let mut best = None;
    let mut max_resolution = 0.0_f64;
    for &source in sources {
        let Some(srcset) = attr(doc, source, "srcset").filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(width) = WIDTH.captures(&srcset) else {
            continue;
        };
        let dpr = DPR
            .captures(&srcset)
            .and_then(|c| parse_float(&c[1]))
            .unwrap_or(1.0);
        let resolution = parse_int(&width[1]).unwrap_or(0) as f64 * dpr;
        if resolution > max_resolution {
            max_resolution = resolution;
            best = Some(source);
        }
    }
    best.or(Some(sources[0]))
}

/// `applySrcsetToImage(srcset, img)`.
pub fn apply_srcset_to_image(doc: &mut Document, srcset: &str, img: NodeId) {
    doc.set_attribute(img, "srcset", srcset);
    if let Some(first) = extract_first_url_from_srcset(srcset)
        && is_valid_image_url(&first)
    {
        doc.set_attribute(img, "src", &first);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_url_handles_commas_in_urls() {
        // Values read from the JS: Substack CDN urls hold commas.
        assert_eq!(
            extract_first_url_from_srcset(
                "https://cdn.test/fetch/$s_!Y!,w_424,c_limit/a.webp 424w, https://cdn.test/b.webp 848w"
            )
            .as_deref(),
            Some("https://cdn.test/fetch/$s_!Y!,w_424,c_limit/a.webp")
        );
        assert_eq!(
            extract_first_url_from_srcset("a.jpg").as_deref(),
            Some("a.jpg")
        );
        assert_eq!(
            extract_first_url_from_srcset("data:image/svg+xml,x 1x, b.png 2x").as_deref(),
            Some("b.png")
        );
        assert_eq!(extract_first_url_from_srcset("   "), None);
    }

    #[test]
    fn valid_urls() {
        assert!(is_valid_image_url("https://x.test/a.JPG?w=1"));
        assert!(is_valid_image_url("https://x.test/photo/1"));
        assert!(!is_valid_image_url("data:image/png;base64,AAAA"));
        assert!(!is_valid_image_url("https://x.test/a.html"));
        assert!(!is_valid_image_url("  "));
    }
}

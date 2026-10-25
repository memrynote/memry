//! The `image`, `figure` and `embedToMarkdown` rules and `getBestImageSrc`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::markdown::turndown::NodeInfo;
use crate::web::extract::markdown::turndown::parse::Dom;
use crate::web::extract::utils::js::{is_js_whitespace, split_whitespace_runs, trim};

static WIDTH_DESCRIPTOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]+)w,?$").expect("static pattern"));
static DENSITY_DESCRIPTOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+(?:\.[0-9]+)?x,?$").expect("static pattern"));
static YOUTUBE_SRC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:youtube\.com|youtube-nocookie\.com|youtu\.be)").expect("static pattern")
});
static TWITTER_SRC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:twitter\.com|x\.com)").expect("static pattern"));
static YOUTUBE_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:https?://)?(?:www\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)/(?:embed/|watch\?v=)?([a-zA-Z0-9_-]+)",
    )
    .expect("static pattern")
});
static TWEET_DIRECT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:https?://)?(?:www\.)?(?:twitter\.com|x\.com)/([^/]+)/status/([0-9]+)")
        .expect("static pattern")
});
static TWEET_EMBED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:https?://)?(?:platform\.)?twitter\.com/embed/Tweet\.html\?[^\n\r\u{2028}\u{2029}]*?id=([0-9]+)")
        .expect("static pattern")
});

/// `getBestImageSrc(node)`: the widest `srcset` candidate, else `src`.
fn best_image_src(dom: &Dom, node: NodeId) -> String {
    if let Some(srcset) = dom.attr(node, "srcset").filter(|s| !s.is_empty()) {
        let mut best_url = String::new();
        let mut best_width = 0.0_f64;
        // Tokens, not commas: CDN URLs hold commas (`w_424,c_limit`).
        let mut url_parts: Vec<&str> = Vec::new();
        for token in split_whitespace_runs(trim(srcset)) {
            if let Some(caps) = WIDTH_DESCRIPTOR.captures(token) {
                let width = caps[1].parse::<f64>().unwrap_or(0.0);
                if !url_parts.is_empty() && width > best_width {
                    let joined = url_parts.join(" ");
                    let url = match joined.strip_prefix(',') {
                        Some(rest) => rest.trim_start_matches(is_js_whitespace),
                        None => joined.as_str(),
                    };
                    if !url.is_empty() {
                        best_width = width;
                        best_url = url.to_string();
                    }
                }
                url_parts = Vec::new();
            } else if DENSITY_DESCRIPTOR.is_match(token) {
                url_parts = Vec::new();
            } else {
                url_parts.push(token);
            }
        }
        if !best_url.is_empty() {
            return best_url;
        }
    }
    dom.attr(node, "src").unwrap_or_default().to_string()
}

pub fn image(dom: &mut Dom, node: NodeId, _: &str, _: &NodeInfo) -> String {
    let alt = dom.attr(node, "alt").unwrap_or_default();
    let src = best_image_src(dom, node);
    let title = dom.attr(node, "title").unwrap_or_default();
    let title_part = if title.is_empty() {
        String::new()
    } else {
        format!(" \"{title}\"")
    };
    if src.is_empty() {
        return String::new();
    }
    format!("![{alt}]({src}{title_part})")
}

pub fn is_embed(dom: &Dom, node: NodeId) -> bool {
    dom.attr(node, "src").is_some_and(|src| {
        !src.is_empty() && (YOUTUBE_SRC.is_match(src) || TWITTER_SRC.is_match(src))
    })
}

pub fn embed(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    if let Some(src) = dom.attr(node, "src").filter(|s| !s.is_empty()) {
        if let Some(caps) = YOUTUBE_ID.captures(src) {
            return format!("\n![](https://www.youtube.com/watch?v={})\n", &caps[1]);
        }
        // Direct URL: /user/status/id
        if let Some(caps) = TWEET_DIRECT.captures(src) {
            return format!("\n![](https://x.com/{}/status/{})\n", &caps[1], &caps[2]);
        }
        // Platform embed: ?id=
        if let Some(caps) = TWEET_EMBED.captures(src) {
            return format!("\n![](https://x.com/i/status/{})\n", &caps[1]);
        }
    }
    content.to_string()
}

pub fn figure(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    let Some(img) = dom.query_name(node, &["img"]) else {
        return content.to_string();
    };
    let figcaption = dom.query_name(node, &["figcaption"]);
    // A `<p>` outside the `<figcaption>` makes the figure a content wrapper (Medium's layout).
    let has_paragraphs_outside = dom.query_names(node, &["p"]).into_iter().any(|p| {
        let mut ancestor = dom.doc.parent_node(p);
        while let Some(a) = ancestor {
            if a == node {
                break;
            }
            if dom.is_name(a, "FIGCAPTION") {
                return false;
            }
            ancestor = dom.doc.parent_node(a);
        }
        true
    });
    if has_paragraphs_outside {
        return content.to_string();
    }
    let alt = dom.attr(img, "alt").unwrap_or_default().to_string();
    let src = best_image_src(dom, img);
    let mut caption = String::new();
    if let Some(figcaption) = figcaption {
        let tag_text = dom
            .query_class(figcaption, "ltx_tag_figure")
            .first()
            .map_or(String::new(), |&span| trim(&dom.text(span)).to_string());
        let markdown = dom.turndown(&dom.inner_html(figcaption));
        caption = trim(&format!("{tag_text} {markdown}")).to_string();
    }
    format!("![{alt}]({src})\n\n{caption}\n\n")
}

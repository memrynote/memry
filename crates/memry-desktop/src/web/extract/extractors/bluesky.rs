//! `dist/extractors/bluesky.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{
    Comment, QuotedPost, build_comment_tree, build_content_html, build_quoted_post,
};
use crate::web::extract::utils::date::{iso_date_from_millis, iso_date_or_empty, parse_date};
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::trim;

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, description_cut, post_title, text_of, trimmed,
};

const ITEM: &str = r#"[data-testid^="postThreadItem-by-"]"#;

pub struct BlueskyExtractor {
    items: Vec<NodeId>,
}

impl BlueskyExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let items = match cx.qs(r#"[data-testid="postThreadScreen"]"#)? {
            Some(screen) => cx.doc.query_selector_all(screen, ITEM)?,
            None => Vec::new(),
        };
        Ok(Self { items })
    }
}

fn handle_of(cx: &Cx, item: NodeId) -> String {
    static HANDLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^postThreadItem-by-([^\n\r\x{2028}\x{2029}]+)$").expect("static")
    });
    HANDLE
        .captures(&attr_of(cx.doc, item, "data-testid"))
        .map(|m| m[1].to_string())
        .unwrap_or_default()
}

fn display_name(cx: &Cx, item: NodeId) -> Result<String, ExtractError> {
    static AVATAR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^([^\n\r\x{2028}\x{2029}]+)'s avatar$").expect("static"));
    if let Some(link) = cx.doc.query_selector(item, r#"a[aria-label*="avatar"]"#)?
        && let Some(m) = AVATAR.captures(&attr_of(cx.doc, link, "aria-label"))
    {
        return Ok(m[1].to_string());
    }
    for link in cx.doc.query_selector_all(item, r#"a[href^="/profile/"]"#)? {
        let text = trimmed(cx.doc, link);
        if !text.is_empty()
            && !text.starts_with('@')
            && !text.contains("avatar")
            && !text.contains('·')
        {
            return Ok(text);
        }
    }
    Ok(String::new())
}

fn clean_text(cx: &mut Cx, text_div: NodeId) -> Result<String, ExtractError> {
    let clone = cx.doc.clone_node(text_div, true);
    for link in cx
        .doc
        .query_selector_all(clone, r#"a[href*="/profile/"]"#)?
    {
        let text = trimmed(cx.doc, link);
        let href = attr_of(cx.doc, link, "href");
        if let Some(handle) = text.strip_prefix('@') {
            let clean = cx.doc.create_element("a");
            cx.doc
                .set_attribute(clean, "href", &format!("https://bsky.app/profile/{handle}"));
            cx.doc.set_text_content(clean, &text)?;
            cx.doc.replace_with(link, &[clean])?;
        } else if href.starts_with("/profile/") {
            cx.doc
                .set_attribute(link, "href", &format!("https://bsky.app{href}"));
        }
    }
    for link in cx.doc.query_selector_all(clone, r#"a[href^="http"]"#)? {
        let href = attr_of(cx.doc, link, "href");
        let text = trimmed(cx.doc, link);
        let clean = cx.doc.create_element("a");
        cx.doc.set_attribute(clean, "href", &href);
        cx.doc.set_text_content(clean, &text)?;
        cx.doc.replace_with(link, &[clean])?;
    }
    for el in cx.doc.query_selector_all(clone, "span, div")? {
        let children = cx.doc.child_nodes(el);
        cx.doc.replace_with(el, &children)?;
    }
    let html = cx.doc.inner_html(clone);
    let html = if html.is_empty() {
        text_of(cx.doc, clone)
    } else {
        html
    };
    let html = trim(&html).to_string();
    let html: String = html
        .chars()
        .filter(|c| !matches!(c, '\u{200E}' | '\u{200F}' | '\u{200B}'))
        .collect();
    // `[^\S\n]+`: whitespace except the newline.
    static SPACES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"[\t\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+")
            .expect("static")
    });
    let html = trim(&SPACES.replace_all(&html, " ")).to_string();
    if html.is_empty() {
        return Ok(String::new());
    }
    let paragraphs: Vec<String> = html
        .split('\n')
        .map(|p| trim(p).to_string())
        .filter(|p| !p.is_empty())
        .map(|p| format!("<p>{p}</p>"))
        .collect();
    Ok(paragraphs.join("\n"))
}

fn images(cx: &Cx, item: NodeId) -> Result<String, ExtractError> {
    let mut out = Vec::new();
    for img in cx.doc.query_selector_all(
        item,
        r#"img[src*="/feed_thumbnail/"], img[src*="/feed_fullsize/"]"#,
    )? {
        let src = attr_of(cx.doc, img, "src");
        if src.is_empty() {
            continue;
        }
        let full = src.replacen("/feed_thumbnail/", "/feed_fullsize/", 1);
        out.push(format!("<img src=\"{}\" alt=\"\" />", escape_html(&full)));
    }
    Ok(out.join("\n"))
}

fn link_card(cx: &Cx, item: NodeId) -> Result<String, ExtractError> {
    for link in cx
        .doc
        .query_selector_all(item, r#"a[aria-label][href^="http"]"#)?
    {
        if cx
            .doc
            .query_selector(link, r#"div[style*="border"]"#)?
            .is_none()
        {
            continue;
        }
        let href = attr_of(cx.doc, link, "href");
        let title = attr_of(cx.doc, link, "aria-label");
        if title.is_empty() {
            continue;
        }
        let mut html = String::new();
        if let Some(img) = cx.doc.query_selector(link, "img")? {
            html.push_str(&format!(
                "<a href=\"{}\"><img src=\"{}\" alt=\"{}\" /></a>\n",
                escape_html(&href),
                escape_html(&attr_of(cx.doc, img, "src")),
                escape_html(&title)
            ));
        }
        html.push_str(&format!(
            "<p><a href=\"{}\">{}</a></p>",
            escape_html(&href),
            escape_html(&title)
        ));
        return Ok(html);
    }
    Ok(String::new())
}

fn quoted_post(cx: &mut Cx, item: NodeId) -> Result<String, ExtractError> {
    for embed in cx.doc.query_selector_all(item, ITEM)? {
        if embed == item {
            continue;
        }
        let handle = handle_of(cx, embed);
        let name = display_name(cx, embed)?;
        let text = match cx.doc.query_selector(embed, r#"div[data-word-wrap="1"]"#)? {
            Some(div) => clean_text(cx, div)?,
            None => String::new(),
        };
        return Ok(build_quoted_post(&QuotedPost {
            author: if name.is_empty() {
                format!("@{handle}")
            } else {
                format!("{name} @{handle}")
            },
            content: text,
            ..QuotedPost::default()
        }));
    }
    Ok(String::new())
}

fn post_content(cx: &mut Cx, item: NodeId) -> Result<String, ExtractError> {
    let mut parts = Vec::new();
    if let Some(div) = cx.doc.query_selector(item, r#"div[data-word-wrap="1"]"#)? {
        let text = clean_text(cx, div)?;
        if !text.is_empty() {
            parts.push(text);
        }
    }
    for part in [
        images(cx, item)?,
        link_card(cx, item)?,
        quoted_post(cx, item)?,
    ] {
        if !part.is_empty() {
            parts.push(part);
        }
    }
    Ok(parts.join("\n"))
}

fn has_top_connector(cx: &Cx, item: NodeId) -> Result<bool, ExtractError> {
    let Some(connector) = cx.doc.children(item).first().copied() else {
        return Ok(false);
    };
    for div in cx.doc.query_selector_all(connector, "div")? {
        let style = attr_of(cx.doc, div, "style");
        if style.contains("width: 2px") && style.contains("background-color") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn reply_date(cx: &Cx, item: NodeId) -> Result<String, ExtractError> {
    let Some(link) = cx.doc.query_selector(item, r#"a[href*="/post/"]"#)? else {
        return Ok(String::new());
    };
    let label = attr_of(cx.doc, link, "aria-label");
    if label.is_empty() {
        return Ok(String::new());
    }
    Ok(match parse_date(&label.replacen(" at ", " ", 1)) {
        Some(ms) => iso_date_from_millis(ms).unwrap_or_default(),
        None => String::new(),
    })
}

fn permalink(cx: &Cx, item: NodeId) -> Result<String, ExtractError> {
    let Some(link) = cx.doc.query_selector(item, r#"a[href*="/post/"]"#)? else {
        return Ok(String::new());
    };
    let href = attr_of(cx.doc, link, "href");
    Ok(if href.starts_with("http") {
        href
    } else {
        format!("https://bsky.app{href}")
    })
}

impl Extractor for BlueskyExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(!self.items.is_empty())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let first = self.items[0];
        let main_handle = handle_of(cx, first);
        let mut thread = Vec::new();
        let mut replies = Vec::new();
        let mut ended = false;
        for &item in &self.items {
            if !ended && handle_of(cx, item) == main_handle {
                thread.push(item);
            } else {
                ended = true;
                replies.push(item);
            }
        }
        let mut parts = Vec::new();
        for &item in &thread {
            parts.push(post_content(cx, item)?);
        }
        let content = parts.join("\n<hr>\n");

        let mut data = Vec::new();
        let mut depth = 0.0;
        for &item in &replies {
            let handle = handle_of(cx, item);
            let name = display_name(cx, item)?;
            let body = post_content(cx, item)?;
            let date = reply_date(cx, item)?;
            let link = permalink(cx, item)?;
            if has_top_connector(cx, item)? {
                depth += 1.0
            } else {
                depth = 0.0
            }
            data.push(Comment {
                author: if name.is_empty() {
                    format!("@{handle}")
                } else {
                    format!("{name} @{handle}")
                },
                date,
                content: body,
                depth: Some(depth),
                url: Some(link).filter(|u| !u.is_empty()),
                score: None,
            });
        }
        let comments = if data.is_empty() {
            String::new()
        } else {
            build_comment_tree(&data)
        };
        let content_html = build_content_html("bluesky", &content, &comments);

        let author = format!("@{main_handle}");
        let name = display_name(cx, first)?;
        let description = match cx.doc.query_selector(first, r#"div[data-word-wrap="1"]"#)? {
            Some(div) => {
                let text: String = text_of(cx.doc, div)
                    .chars()
                    .filter(|c| !matches!(c, '\u{200E}' | '\u{200F}' | '\u{200B}'))
                    .collect();
                description_cut(trim(&text))
            }
            None => String::new(),
        };
        let published = match cx.qs(r#"meta[name="twitter:value1"]"#)? {
            Some(meta) => iso_date_or_empty(&attr_of(cx.doc, meta, "content")),
            None => String::new(),
        };
        let shown = if name.is_empty() { author } else { name };
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title: post_title(&shown, "Bluesky"),
                author: shown,
                site: "Bluesky".into(),
                description,
                published,
                ..Variables::default()
            },
        })
    }
}

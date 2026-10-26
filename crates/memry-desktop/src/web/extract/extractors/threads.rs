//! `dist/extractors/threads.js`: Threads post pages, rendered (pagelets) or server-side (a
//! `role="region"` plus hydration JSON).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{
    Comment, QuotedPost, build_comment_tree, build_content_html, build_quoted_post,
};
use crate::web::extract::utils::date::iso_date_or_empty;
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::{WS, decode_uri_component, parse_int, trim, utf16_slice};
use crate::web::extract::utils::json::{JsValue, parse};

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, description_cut, post_title, text_of, trimmed,
};

const PAGELET: &str = r#"[data-pagelet^="threads_post_page_"]"#;
const PRESSABLE: &str = "[data-pressable-container]";

pub struct ThreadsExtractor {
    pagelets: Vec<NodeId>,
    region: Option<NodeId>,
}

struct Post {
    username: String,
    date: String,
    permalink: String,
    content: String,
    element: NodeId,
}

static SHORT_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{2}/[0-9]{2}/[0-9]{2}$").expect("static"));
static POST_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@?[A-Za-z0-9_]+/post/[A-Za-z0-9_]+$").expect("static"));
static THREAD_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"{WS}*[0-9]+{WS}*/{WS}*[0-9]+{WS}*$")).expect("static"));
static FRACTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+/[0-9]+$").expect("static"));
static PERMALINK_HREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/@[A-Za-z0-9_.]+/post/").expect("static"));
static COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<!--[^\n\r\x{2028}\x{2029}]*?-->").expect("static"));
static RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static"));
static USER_HREF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/@([^/]+)").expect("static"));
static QUOTED_HREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/@([^/]+)/post/").expect("static"));

impl ThreadsExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let mut pagelets = Vec::new();
        for p in cx.qsa(PAGELET)? {
            if cx
                .doc
                .query_selector(p, r#"a[href^="/@"], time[datetime]"#)?
                .is_some()
            {
                pagelets.push(p);
            }
        }
        let mut region = None;
        if pagelets.is_empty()
            && let Some(r) = cx.qs(r#"div[role="region"]"#)?
            && cx.doc.query_selector(r, r#"a[href^="/@"]"#)?.is_some()
        {
            region = Some(r);
        }
        Ok(Self { pagelets, region })
    }
}

fn username(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    for link in cx
        .doc
        .query_selector_all(container, r#"a[href^="/@"][role="link"]"#)?
    {
        let text = trimmed(cx.doc, link);
        if !text.is_empty() && !text.contains("profile picture") {
            return Ok(text);
        }
    }
    if let Some(first) = cx.doc.query_selector(container, r#"a[href^="/@"]"#)? {
        let href = attr_of(cx.doc, first, "href");
        return Ok(USER_HREF
            .captures(&href)
            .map(|m| m[1].to_string())
            .unwrap_or_default());
    }
    Ok(String::new())
}

fn date_of(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    Ok(match cx.doc.query_selector(container, "time[datetime]")? {
        Some(t) => iso_date_or_empty(&attr_of(cx.doc, t, "datetime")),
        None => String::new(),
    })
}

fn permalink_of(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    let Some(link) = cx.doc.query_selector(container, r#"a[href*="/post/"]"#)? else {
        return Ok(String::new());
    };
    let href = attr_of(cx.doc, link, "href");
    Ok(if href.starts_with("http") {
        href
    } else {
        format!("https://www.threads.com{href}")
    })
}

fn strip_thread_number(text: &str) -> String {
    trim(&THREAD_NUMBER.replace(text, "")).to_string()
}

/// `unwrapRedirectUrl(href)`: the `u` parameter of a `l.threads.com` redirect, decoded twice.
fn unwrap_redirect_url(href: &str) -> String {
    let Ok(url) = Url::parse(href) else {
        return href.to_string();
    };
    let Some((_, actual)) = url.query_pairs().find(|(k, _)| k == "u") else {
        return href.to_string();
    };
    if actual.is_empty() {
        return href.to_string();
    }
    decode_uri_component(&actual).unwrap_or_else(|| href.to_string())
}

fn remove_thread_numbers(cx: &mut Cx, container: NodeId) -> Result<(), ExtractError> {
    for div in cx.doc.query_selector_all(container, "div")? {
        let text = trimmed(cx.doc, div);
        if FRACTION.is_match(&text) && cx.doc.query_selector_all(div, "span")?.len() >= 2 {
            cx.doc.remove(div);
        }
    }
    Ok(())
}

fn clean_text(cx: &mut Cx, span: NodeId) -> Result<String, ExtractError> {
    let clone = cx.doc.clone_node(span, true);
    remove_thread_numbers(cx, clone)?;
    for link in cx.doc.query_selector_all(clone, "a")? {
        let href = attr_of(cx.doc, link, "href");
        let text = trimmed(cx.doc, link);
        if PERMALINK_HREF.is_match(&href) {
            cx.doc.remove(link);
            continue;
        }
        let clean = cx.doc.create_element("a");
        if href.contains("l.threads.com") {
            cx.doc
                .set_attribute(clean, "href", &unwrap_redirect_url(&href));
        } else if let Some(user) = href.strip_prefix("/@") {
            cx.doc
                .set_attribute(clean, "href", &format!("https://www.threads.com/@{user}"));
            cx.doc.set_text_content(clean, &format!("@{user}"))?;
            cx.doc.replace_with(link, &[clean])?;
            continue;
        } else {
            let absolute = if href.starts_with("http") {
                href.clone()
            } else {
                format!("https://www.threads.com{href}")
            };
            cx.doc.set_attribute(clean, "href", &absolute);
        }
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
    let html = COMMENT.replace_all(trim(&html), "").into_owned();
    Ok(trim(&RUNS.replace_all(&html, " ")).to_string())
}

fn images(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    let mut out = Vec::new();
    for img in cx.doc.query_selector_all(container, "img")? {
        let alt = attr_of(cx.doc, img, "alt");
        let src = attr_of(cx.doc, img, "src");
        if alt.contains("profile picture") || src.is_empty() {
            continue;
        }
        if cx
            .doc
            .closest(img, r#"a[href*="l.threads.com"]"#)?
            .is_some()
        {
            continue;
        }
        let width = attr_of(cx.doc, img, "width");
        let width = parse_int(if width.is_empty() { "0" } else { &width }).unwrap_or(0);
        if width > 0 && width <= 48 {
            continue;
        }
        out.push(format!(
            "<img src=\"{}\" alt=\"{}\" />",
            escape_html(&src),
            escape_html(&alt)
        ));
    }
    Ok(out.join("\n"))
}

fn link_card(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    for link in cx
        .doc
        .query_selector_all(container, r#"a[href*="l.threads.com"]"#)?
    {
        let Some(img) = cx.doc.query_selector(link, "img")? else {
            continue;
        };
        let actual = unwrap_redirect_url(&attr_of(cx.doc, link, "href"));
        let src = attr_of(cx.doc, img, "src");
        let alt = attr_of(cx.doc, img, "alt");
        if !src.is_empty() {
            return Ok(format!(
                "<a href=\"{}\"><img src=\"{}\" alt=\"{}\" /></a>",
                escape_html(&actual),
                escape_html(&src),
                escape_html(&alt)
            ));
        }
    }
    Ok(String::new())
}

fn quoted_from(cx: &Cx, quoted: NodeId) -> Result<String, ExtractError> {
    let name = username(cx, quoted)?;
    let date = date_of(cx, quoted)?;
    let mut content = String::new();
    for span in cx.doc.query_selector_all(quoted, r#"span[dir="auto"]"#)? {
        if cx.doc.closest(span, r#"[role="button"], time"#)?.is_some() {
            continue;
        }
        if let Some(link) = cx.doc.closest(span, r#"a[href^="/@"]"#)?
            && !attr_of(cx.doc, link, "href").contains("/post/")
        {
            continue;
        }
        let text = trimmed(cx.doc, span);
        if text.is_empty() || text == "·" || text == "Author" || SHORT_DATE.is_match(&text) {
            continue;
        }
        let cleaned = strip_thread_number(&text);
        if !cleaned.is_empty() {
            content.push_str(&format!("<p>{}</p>\n", escape_html(&cleaned)));
        }
    }
    Ok(build_quoted_post(&QuotedPost {
        author: if name.is_empty() {
            String::new()
        } else {
            format!("@{name}")
        },
        date,
        content: trim(&content).to_string(),
        url: String::new(),
    }))
}

fn quoted_post(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    if let Some(nested) = cx.doc.query_selector(container, PRESSABLE)? {
        return quoted_from(cx, nested);
    }
    for link in cx
        .doc
        .query_selector_all(container, r#"a[href*="/post/"]"#)?
    {
        let text = trimmed(cx.doc, link);
        if SHORT_DATE.is_match(&text) {
            continue;
        }
        let href = attr_of(cx.doc, link, "href");
        let Some(m) = QUOTED_HREF.captures(&href) else {
            continue;
        };
        let permalink = if href.starts_with("http") {
            href.clone()
        } else {
            format!("https://www.threads.com{href}")
        };
        return Ok(build_quoted_post(&QuotedPost {
            author: format!("@{}", &m[1]),
            date: String::new(),
            content: format!("<p>{}</p>", escape_html(&text)),
            url: permalink,
        }));
    }
    Ok(String::new())
}

/// The text spans of a post that are neither chrome nor the thread counter.
fn is_noise_text(text: &str) -> bool {
    text.is_empty()
        || matches!(text, "Author" | "·" | "Top" | "View activity")
        || SHORT_DATE.is_match(text)
}

fn post_content(cx: &mut Cx, container: NodeId) -> Result<String, ExtractError> {
    let mut parts = Vec::new();
    for span in cx
        .doc
        .query_selector_all(container, r#"span[dir="auto"]"#)?
    {
        if cx
            .doc
            .closest(
                span,
                r#"a[href^="/@"], a[href*="/post/"], a[href*="l.threads.com"], time"#,
            )?
            .is_some()
            || cx.doc.closest(span, r#"[role="button"]"#)?.is_some()
        {
            continue;
        }
        let text = trimmed(cx.doc, span);
        if is_noise_text(&text) || POST_PATH.is_match(&text) {
            continue;
        }
        if strip_thread_number(&text).is_empty() {
            continue;
        }
        let html = clean_text(cx, span)?;
        if !html.is_empty() {
            parts.push(format!("<p>{html}</p>"));
        }
    }
    for part in [
        images(cx, container)?,
        link_card(cx, container)?,
        quoted_post(cx, container)?,
    ] {
        if !part.is_empty() {
            parts.push(part);
        }
    }
    Ok(parts.join("\n"))
}

fn description(cx: &Cx, container: Option<NodeId>) -> Result<String, ExtractError> {
    let Some(container) = container else {
        return Ok(String::new());
    };
    for span in cx
        .doc
        .query_selector_all(container, r#"span[dir="auto"]"#)?
    {
        if cx
            .doc
            .closest(
                span,
                r#"a[href^="/@"], [role="button"], a[href*="/post/"], time"#,
            )?
            .is_some()
        {
            continue;
        }
        let text = trimmed(cx.doc, span);
        if is_noise_text(&text) {
            continue;
        }
        let cleaned = strip_thread_number(&text);
        if !cleaned.is_empty() {
            return Ok(description_cut(&cleaned));
        }
    }
    Ok(String::new())
}

fn posts_from_pagelet(cx: &mut Cx, pagelet: NodeId) -> Result<Vec<Post>, ExtractError> {
    let mut posts = Vec::new();
    for container in cx.doc.query_selector_all(pagelet, PRESSABLE)? {
        if let Some(parent) = cx.doc.parent_element(container)
            && cx.doc.closest(parent, PRESSABLE)?.is_some()
        {
            continue;
        }
        let name = username(cx, container)?;
        if name.is_empty() {
            continue;
        }
        posts.push(Post {
            username: name,
            date: date_of(cx, container)?,
            permalink: permalink_of(cx, container)?,
            content: post_content(cx, container)?,
            element: container,
        });
    }
    Ok(posts)
}

/// `extractTextFromJson(obj, depth)`; `Err` is a JS `TypeError`.
fn text_from_json(obj: &JsValue, depth: usize) -> Result<Option<String>, ExtractError> {
    if depth > 10 || !obj.is_object_like() {
        return Ok(None);
    }
    if let Some(fragments) = obj
        .get("text_fragments")
        .and_then(|t| t.get("fragments"))
        .filter(|f| f.truthy())
    {
        let JsValue::Array(items) = fragments else {
            return Err(ExtractError::Js(
                "TypeError: fragments.map is not a function".into(),
            ));
        };
        let mut text = String::new();
        for f in items {
            if matches!(f, JsValue::Null) {
                return Err(ExtractError::Js("TypeError: f is null".into()));
            }
            if let Some(p) = f.get("plaintext").filter(|p| p.truthy()) {
                text.push_str(&p.to_js_string());
            } else if let Some(u) = f
                .get("mention_fragment")
                .and_then(|m| m.get("username"))
                .filter(|u| u.truthy())
            {
                text.push_str(&format!("@{}", u.to_js_string()));
            } else if let Some(l) = f.get("linkified_web_url").filter(|l| l.truthy()) {
                text.push_str(&l.to_js_string());
            }
        }
        return Ok(Some(text));
    }
    for child in json_children(obj) {
        if let Some(text) = text_from_json(child, depth + 1)?.filter(|t| !t.is_empty()) {
            return Ok(Some(text));
        }
    }
    Ok(None)
}

/// The values of `Object.keys(obj)` in order, without `quoted_post`.
fn json_children(obj: &JsValue) -> Vec<&JsValue> {
    match obj {
        JsValue::Array(items) => items.iter().collect(),
        JsValue::Object(entries) => entries
            .iter()
            .filter(|(k, _)| k != "quoted_post")
            .map(|(_, v)| v)
            .collect(),
        _ => Vec::new(),
    }
}

fn posts_in_json(
    obj: &JsValue,
    depth: usize,
    out: &mut Vec<(String, String)>,
) -> Result<(), ExtractError> {
    if depth > 35 || !obj.is_object_like() {
        return Ok(());
    }
    if let Some(JsValue::String(name)) = obj.get("user").and_then(|u| u.get("username"))
        && !name.is_empty()
        && let Some(text) = text_from_json(obj, 0)?.filter(|t| !t.is_empty())
    {
        out.push((name.clone(), text));
    }
    for child in json_children(obj) {
        posts_in_json(child, depth + 1, out)?;
    }
    Ok(())
}

fn comments_from_json(cx: &Cx, main_author: &str) -> Result<String, ExtractError> {
    let mut all: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for script in cx.qsa(r#"script[type="application/json"]"#)? {
        let raw = text_of(cx.doc, script);
        if raw.matches("\"text_fragments\"").count() < 2 || !raw.contains("\"username\"") {
            continue;
        }
        let Ok(data) = parse(&raw) else { continue };
        let mut found = Vec::new();
        if posts_in_json(&data, 0, &mut found).is_err() {
            continue;
        }
        for (user, text) in found {
            let key = format!("{user}:{}", utf16_slice(&text, 0, 80));
            if seen.insert(key) {
                all.push((user, text));
            }
        }
    }
    if all.len() < 2 {
        return Ok(String::new());
    }
    let mut first = true;
    let mut data = Vec::new();
    for (user, text) in all {
        if first && user == main_author {
            first = false;
            continue;
        }
        data.push(Comment {
            author: format!("@{user}"),
            content: format!("<p>{}</p>", escape_html(&text)),
            depth: Some(0.0),
            ..Comment::default()
        });
    }
    Ok(if data.is_empty() {
        String::new()
    } else {
        build_comment_tree(&data)
    })
}

impl ThreadsExtractor {
    fn extract_from_region(&self, cx: &mut Cx, region: NodeId) -> Result<Extracted, ExtractError> {
        let main = username(cx, region)?;
        if main.is_empty() {
            return Ok(Extracted::default());
        }
        let author = format!("@{main}");
        let content = post_content(cx, region)?;
        let comments = comments_from_json(cx, &main)?;
        Ok(Extracted {
            content_html: build_content_html("threads", &content, &comments),
            content_selector: None,
            variables: Variables {
                title: post_title(&author, "Threads"),
                author,
                site: "Threads".into(),
                description: description(cx, Some(region))?,
                published: date_of(cx, region)?,
                ..Variables::default()
            },
        })
    }
}

impl Extractor for ThreadsExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(!self.pagelets.is_empty() || self.region.is_some())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        if self.pagelets.is_empty()
            && let Some(region) = self.region
        {
            return self.extract_from_region(cx, region);
        }
        let main_author = username(cx, self.pagelets[0])?;
        let mut thread: Vec<Post> = Vec::new();
        let mut replies: Vec<Vec<Post>> = Vec::new();
        let mut ended = false;
        for &pagelet in &self.pagelets.clone() {
            let mut posts = posts_from_pagelet(cx, pagelet)?;
            if posts.is_empty() {
                continue;
            }
            if !ended && posts[0].username == main_author && posts.len() == 1 {
                thread.push(posts.remove(0));
            } else {
                ended = true;
                replies.push(posts);
            }
        }
        let post_content = thread
            .iter()
            .map(|p| p.content.as_str())
            .collect::<Vec<_>>()
            .join("\n<hr>\n");
        let mut data = Vec::new();
        for posts in &replies {
            for (i, post) in posts.iter().enumerate() {
                data.push(Comment {
                    author: format!("@{}", post.username),
                    date: post.date.clone(),
                    content: post.content.clone(),
                    depth: Some(if posts.len() == 1 { 0.0 } else { i as f64 }),
                    url: Some(post.permalink.clone()).filter(|u| !u.is_empty()),
                    score: None,
                });
            }
        }
        let comments = if data.is_empty() {
            String::new()
        } else {
            build_comment_tree(&data)
        };
        let content_html = build_content_html("threads", &post_content, &comments);
        let author = format!("@{main_author}");
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title: post_title(&author, "Threads"),
                author,
                site: "Threads".into(),
                description: description(cx, thread.first().map(|p| p.element))?,
                published: thread.first().map(|p| p.date.clone()).unwrap_or_default(),
                ..Variables::default()
            },
        })
    }
}

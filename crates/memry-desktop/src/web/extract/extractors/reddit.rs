//! `dist/extractors/reddit.js`: a `shreddit-post` page or old Reddit. Comment pages are
//! fetched from old.reddit.com, because that has the comments in the HTML.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::fetch::{FetchRequest, Fetcher};
use crate::web::extract::utils::comments::{Comment, build_comment_tree, build_content_html};
use crate::web::extract::utils::date::iso_date_or_empty;
use crate::web::extract::utils::js::{WS, parse_int, utf16_slice};

use super::base::{Cx, Extracted, Extractor, Variables, attr_of, trimmed};

pub struct RedditExtractor {
    shreddit_post: Option<NodeId>,
    is_old: bool,
    url: String,
}

static COMMENTS_PAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/r/[^\n\r\x{2028}\x{2029}]+/comments/").expect("static"));
static SUBREDDIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/r/([^/]+)").expect("static"));
static RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static"));

impl RedditExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            shreddit_post: cx.qs("shreddit-post")?,
            is_old: cx.qs(".thing.link")?.is_some(),
            url: cx.url.to_string(),
        })
    }

    fn is_comments_page(&self) -> bool {
        COMMENTS_PAGE.is_match(&self.url)
    }
}

/// `createDescription(postContent)`: the text of the HTML, cut.
fn description(doc: &mut Document, post_content: &str) -> Result<String, ExtractError> {
    if post_content.is_empty() {
        return Ok(String::new());
    }
    let div = doc.create_element("div");
    let fragment = doc.parse_fragment(post_content);
    doc.append_child(div, fragment)?;
    let text = trimmed(doc, div);
    Ok(RUNS
        .replace_all(&utf16_slice(&text, 0, 140), " ")
        .into_owned())
}

/// `new Date(datetime).toISOString()` throws a `RangeError` for an invalid date; a comment with
/// one fails the whole extraction.
fn strict_day(datetime: &str) -> Result<String, ExtractError> {
    if datetime.is_empty() {
        return Ok(String::new());
    }
    let date = iso_date_or_empty(datetime);
    if date.is_empty() {
        return Err(ExtractError::Js("RangeError: Invalid time value".into()));
    }
    Ok(date)
}

fn collect_old_comments(
    doc: &Document,
    container: NodeId,
    depth: f64,
    out: &mut Vec<Comment>,
) -> Result<(), ExtractError> {
    for comment in doc.query_selector_all(container, ":scope > .thing.comment")? {
        let permalink = attr_of(doc, comment, "data-permalink");
        let score = match doc.query_selector(comment, ".entry .tagline .score.unvoted")? {
            Some(el) => trimmed(doc, el),
            None => String::new(),
        };
        let datetime = match doc.query_selector(comment, ".entry .tagline time[datetime]")? {
            Some(el) => attr_of(doc, el, "datetime"),
            None => String::new(),
        };
        let body = match doc.query_selector(comment, ".entry .usertext-body .md")? {
            Some(el) => doc.inner_html(el),
            None => String::new(),
        };
        out.push(Comment {
            author: attr_of(doc, comment, "data-author"),
            date: strict_day(&datetime)?,
            content: body,
            depth: Some(depth),
            score: Some(score).filter(|s| !s.is_empty()),
            url: (!permalink.is_empty()).then(|| format!("https://reddit.com{permalink}")),
        });
        if let Some(child) = doc.query_selector(comment, ".child > .sitetable")? {
            collect_old_comments(doc, child, depth + 1.0, out)?;
        }
    }
    Ok(())
}

/// `extractOldReddit(root)`, over the document `doc` whose root node is `root`.
fn extract_old_reddit(doc: &mut Document, root: NodeId) -> Result<Extracted, ExtractError> {
    let thing = doc.query_selector(root, ".thing.link")?;
    let (title, author, subreddit, body_el) = match thing {
        Some(t) => (
            match doc.query_selector(t, "a.title")? {
                Some(el) => trimmed(doc, el),
                None => String::new(),
            },
            attr_of(doc, t, "data-author"),
            attr_of(doc, t, "data-subreddit"),
            doc.query_selector(t, ".usertext-body .md")?,
        ),
        None => (String::new(), String::new(), String::new(), None),
    };
    let post_body = body_el.map(|el| doc.inner_html(el)).unwrap_or_default();
    let mut data = Vec::new();
    if let Some(area) = doc.query_selector(root, ".commentarea .sitetable")? {
        collect_old_comments(doc, area, 0.0, &mut data)?;
    }
    let comments = if data.is_empty() {
        String::new()
    } else {
        build_comment_tree(&data)
    };
    Ok(Extracted {
        content_html: build_content_html("reddit", &post_body, &comments),
        content_selector: None,
        variables: Variables {
            title,
            author,
            site: format!("r/{subreddit}"),
            description: description(doc, &post_body)?,
            ..Variables::default()
        },
    })
}

impl Extractor for RedditExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.shreddit_post.is_some() || self.is_old)
    }

    fn can_extract_async(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.is_comments_page() && !self.is_old)
    }

    fn prefers_async(&self) -> bool {
        self.is_comments_page() && !self.is_old
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        if self.is_old {
            return extract_old_reddit(cx.doc, cx.root);
        }
        let title = match cx.qs("h1")? {
            Some(el) => trimmed(cx.doc, el),
            None => String::new(),
        };
        let subreddit = SUBREDDIT
            .captures(&self.url)
            .map(|m| m[1].to_string())
            .unwrap_or_default();
        let post_author = self
            .shreddit_post
            .map(|p| attr_of(cx.doc, p, "author"))
            .unwrap_or_default();
        let text_body = match self.shreddit_post {
            Some(p) => match cx.doc.query_selector(p, r#"[slot="text-body"]"#)? {
                Some(el) => cx.doc.inner_html(el),
                None => String::new(),
            },
            None => String::new(),
        };
        let media_body = match self.shreddit_post {
            Some(p) => match cx.doc.query_selector(p, "#post-image")? {
                Some(el) => cx.doc.outer_html(el),
                None => String::new(),
            },
            None => String::new(),
        };
        let post_content = format!("{text_body}{media_body}");
        let description = description(cx.doc, &post_content)?;
        let comments = process_comments(cx)?;
        Ok(Extracted {
            content_html: build_content_html("reddit", &post_content, &comments),
            content_selector: None,
            variables: Variables {
                title,
                author: post_author,
                site: format!("r/{subreddit}"),
                description,
                ..Variables::default()
            },
        })
    }

    fn extract_async(
        &mut self,
        cx: &mut Cx,
        fetcher: &dyn Fetcher,
    ) -> Result<Extracted, ExtractError> {
        let mut old =
            Url::parse(cx.url).map_err(|e| ExtractError::Js(format!("Invalid URL: {e}")))?;
        old.set_host(Some("old.reddit.com"))
            .map_err(|e| ExtractError::Js(e.to_string()))?;
        let response = fetcher
            .fetch(FetchRequest {
                url: old.to_string(),
                method: "GET".into(),
                headers: vec![(
                    "User-Agent".into(),
                    "Mozilla/5.0 (compatible; Defuddle/1.0)".into(),
                )],
                body: None,
            })
            .map_err(ExtractError::Js)?;
        if !response.ok {
            return Err(ExtractError::Js(format!(
                "Failed to fetch old.reddit.com: {}",
                response.status
            )));
        }
        let mut doc = Document::parse_html(&response.text);
        let root = doc.root();
        extract_old_reddit(&mut doc, root)
    }
}

fn process_comments(cx: &mut Cx) -> Result<String, ExtractError> {
    let mut data = Vec::new();
    for comment in cx.qsa("shreddit-comment")? {
        let depth_attr = attr_of(cx.doc, comment, "depth");
        let depth = parse_int(if depth_attr.is_empty() {
            "0"
        } else {
            &depth_attr
        })
        .map_or(f64::NAN, |d| d as f64);
        let score_attr = attr_of(cx.doc, comment, "score");
        let score = if score_attr.is_empty() {
            "0".to_string()
        } else {
            score_attr
        };
        let permalink = attr_of(cx.doc, comment, "permalink");
        let content = match cx.doc.query_selector(comment, r#"[slot="comment"]"#)? {
            Some(el) => cx.doc.inner_html(el),
            None => String::new(),
        };
        let created = attr_of(cx.doc, comment, "created");
        let timestamp = if !created.is_empty() {
            created
        } else {
            match cx.doc.query_selector(comment, "time")? {
                Some(t) => attr_of(cx.doc, t, "datetime"),
                None => String::new(),
            }
        };
        data.push(Comment {
            author: attr_of(cx.doc, comment, "author"),
            date: strict_day(&timestamp)?,
            content,
            depth: Some(depth),
            score: Some(format!("{score} points")),
            url: (!permalink.is_empty()).then(|| format!("https://reddit.com{permalink}")),
        });
    }
    Ok(build_comment_tree(&data))
}

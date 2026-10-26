//! `dist/extractors/hackernews.js`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{
    Comment, build_comment, build_comment_tree, build_content_html,
};
use crate::web::extract::utils::dom::{document_title, escape_html};
use crate::web::extract::utils::js::{WS, parse_int, trim, utf16_len, utf16_slice};

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, sel_attr, sel_text, text_of, trimmed,
};

pub struct HackerNewsExtractor {
    main_post: Option<NodeId>,
    is_listing: bool,
    is_comment_page: bool,
    main_comment: Option<NodeId>,
}

impl HackerNewsExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let main_post = cx.qs(".fatitem")?;
        let is_listing = main_post.is_none() && cx.qsa("tr.athing")?.len() > 1;
        let is_comment_page = match main_post {
            Some(post) => {
                cx.doc.query_selector(post, ".onstory")?.is_some()
                    && cx.doc.query_selector(post, ".titleline")?.is_none()
            }
            None => false,
        };
        let main_comment = match (is_comment_page, main_post) {
            (true, Some(post)) => cx.doc.query_selector(post, "tr.athing")?,
            _ => None,
        };
        Ok(Self {
            main_post,
            is_listing,
            is_comment_page,
            main_comment,
        })
    }

    /// `timestamp.split('T')[0] || ''` of an `.age` element's title.
    fn date_of(cx: &Cx, scope: NodeId) -> Result<String, ExtractError> {
        let title = sel_attr(cx.doc, scope, ".age", "title")?;
        Ok(title.split('T').next().unwrap_or_default().to_string())
    }

    /// `textContent || '[deleted]'` of the `.hnuser` link.
    fn user_of(cx: &Cx, scope: NodeId) -> Result<String, ExtractError> {
        let name = match cx.doc.query_selector(scope, ".hnuser")? {
            Some(el) => text_of(cx.doc, el),
            None => String::new(),
        };
        Ok(if name.is_empty() {
            "[deleted]".to_string()
        } else {
            name
        })
    }

    fn post_title(&self, cx: &Cx) -> Result<String, ExtractError> {
        if self.is_comment_page
            && let Some(comment) = self.main_comment
        {
            let author = Self::user_of(cx, comment)?;
            let text = match cx.doc.query_selector(comment, ".commtext")? {
                Some(el) => text_of(cx.doc, el),
                None => String::new(),
            };
            let preview = format!(
                "{}{}",
                utf16_slice(trim(&text), 0, 50),
                if utf16_len(&text) > 50 { "..." } else { "" }
            );
            return Ok(format!("Comment by {author}: {preview}"));
        }
        match self.main_post {
            Some(post) => sel_text(cx.doc, post, ".titleline"),
            None => Ok(String::new()),
        }
    }

    fn post_author(&self, cx: &Cx) -> Result<String, ExtractError> {
        match self.main_post {
            Some(post) => sel_text(cx.doc, post, ".hnuser"),
            None => Ok(String::new()),
        }
    }

    fn post_content(&self, cx: &Cx) -> Result<String, ExtractError> {
        let Some(post) = self.main_post else {
            return Ok(String::new());
        };
        if self.is_comment_page
            && let Some(comment) = self.main_comment
        {
            let author = Self::user_of(cx, comment)?;
            let text = match cx.doc.query_selector(comment, ".commtext")? {
                Some(el) => cx.doc.inner_html(el),
                None => String::new(),
            };
            let date = Self::date_of(cx, comment)?;
            let points = sel_text(cx.doc, comment, ".score")?;
            return Ok(build_comment(&Comment {
                author,
                date,
                content: text,
                score: Some(points).filter(|p| !p.is_empty()),
                ..Comment::default()
            }));
        }
        let title_row = cx.doc.query_selector(post, "tr.athing")?;
        let url = match title_row {
            Some(row) => sel_attr(cx.doc, row, ".titleline a", "href")?,
            None => String::new(),
        };
        let mut content = String::new();
        if !url.is_empty() {
            content.push_str(&format!(
                "<p><a href=\"{url}\" target=\"_blank\">{url}</a></p>"
            ));
        }
        if let Some(text) = cx.doc.query_selector(post, ".toptext")? {
            content.push_str(&format!(
                "<div class=\"post-text\">{}</div>",
                cx.doc.inner_html(text)
            ));
        }
        Ok(content)
    }

    fn extract_comments(&self, cx: &Cx) -> Result<String, ExtractError> {
        let mut seen = HashSet::new();
        let mut data = Vec::new();
        for row in cx.qsa("tr.comtr")? {
            let id = attr_of(cx.doc, row, "id");
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            let indent = sel_attr(cx.doc, row, ".ind img", "width")?;
            let indent = if indent.is_empty() {
                "0".to_string()
            } else {
                indent
            };
            let depth = parse_int(&indent).map_or(f64::NAN, |n| n as f64) / 40.0;
            let Some(text) = cx.doc.query_selector(row, ".commtext")? else {
                continue;
            };
            let author = Self::user_of(cx, row)?;
            let points = sel_text(cx.doc, row, ".score")?;
            data.push(Comment {
                author,
                date: Self::date_of(cx, row)?,
                content: cx.doc.inner_html(text),
                depth: Some(depth),
                score: Some(points).filter(|p| !p.is_empty()),
                url: Some(format!("https://news.ycombinator.com/item?id={id}")),
            });
        }
        Ok(build_comment_tree(&data))
    }

    fn extract_listing(&self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let mut items = Vec::new();
        for row in cx.qsa("tr.athing")? {
            let id = attr_of(cx.doc, row, "id");
            let Some(title_el) = cx.doc.query_selector(row, ".titleline a")? else {
                continue;
            };
            let title = trimmed(cx.doc, title_el);
            let story_url = attr_of(cx.doc, title_el, "href");
            let site = sel_text(cx.doc, row, ".sitestr")?;
            let sub = cx.doc.next_element_sibling(row);
            let (mut score, mut author, mut comments) =
                (String::new(), String::new(), String::new());
            if let Some(sub) = sub {
                score = sel_text(cx.doc, sub, ".score")?;
                author = sel_text(cx.doc, sub, ".hnuser")?;
                if let Some(&last) = cx.doc.query_selector_all(sub, "td.subtext a")?.last() {
                    let text = trim(&text_of(cx.doc, last).replace('\u{a0}', " ")).to_string();
                    static COMMENT: LazyLock<Regex> = LazyLock::new(|| {
                        Regex::new(&format!("[0-9]+{WS}*comment")).expect("static pattern")
                    });
                    if COMMENT.is_match(&text) {
                        comments = text;
                    }
                }
            }
            let comments_url = if id.is_empty() {
                String::new()
            } else {
                format!("https://news.ycombinator.com/item?id={id}")
            };
            let mut html = String::from("<li>");
            html.push_str(&format!(
                "<a href=\"{}\">{}</a>",
                escape_html(&story_url),
                escape_html(&title)
            ));
            if !site.is_empty() {
                html.push_str(&format!(" <small>({})</small>", escape_html(&site)));
            }
            let mut meta = Vec::new();
            if !score.is_empty() {
                meta.push(escape_html(&score));
            }
            if !author.is_empty() {
                meta.push(format!("by {}", escape_html(&author)));
            }
            if !comments.is_empty() {
                meta.push(format!(
                    "<a href=\"{}\">{}</a>",
                    escape_html(&comments_url),
                    escape_html(&comments)
                ));
            }
            if !meta.is_empty() {
                html.push_str(&format!("<br><small>{}</small>", meta.join(" · ")));
            }
            html.push_str("</li>");
            items.push(html);
        }
        let more = match cx.qs(".morelink")? {
            Some(link) => Some((attr_of(cx.doc, link, "href"), {
                let t = trimmed(cx.doc, link);
                if t.is_empty() { "More".to_string() } else { t }
            })),
            None => None,
        };
        let content_html = if items.is_empty() {
            String::new()
        } else {
            let mut html = format!("<ol>{}</ol>", items.concat());
            if let Some((url, text)) = more {
                html.push_str(&format!(
                    "<p><a href=\"{}\">{}</a></p>",
                    escape_html(&url),
                    escape_html(&text)
                ));
            }
            html
        };
        static TITLE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(&format!("{WS}*\\|{WS}*Hacker News$")).expect("static pattern")
        });
        let page = document_title(cx.doc, cx.root);
        let title = trim(&TITLE_SUFFIX.replace(&page, "")).to_string();
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title: if title.is_empty() {
                    "Hacker News".into()
                } else {
                    title
                },
                site: "Hacker News".into(),
                ..Variables::default()
            },
        })
    }
}

impl Extractor for HackerNewsExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.main_post.is_some() || self.is_listing)
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        if self.is_listing {
            return self.extract_listing(cx);
        }
        let post_content = self.post_content(cx)?;
        let comments = self.extract_comments(cx)?;
        let content_html = build_content_html("hackernews", &post_content, &comments);
        let title = self.post_title(cx)?;
        let author = self.post_author(cx)?;
        let description = if self.is_comment_page {
            format!("Comment by {author} on Hacker News")
        } else {
            format!("{title} - by {author} on Hacker News")
        };
        let published = match self.main_post {
            Some(post) => Self::date_of(cx, post)?,
            None => String::new(),
        };
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title,
                author,
                site: "Hacker News".into(),
                description,
                published,
                ..Variables::default()
            },
        })
    }
}

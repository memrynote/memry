//! `dist/extractors/lwn.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{Comment, build_comment_tree, build_content_html};
use crate::web::extract::utils::date::{iso_date_from_millis, parse_date};
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::{WS, trim};

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, sel_attr, sel_text, text_of, trimmed,
};

pub struct LwnExtractor;

impl LwnExtractor {
    pub fn new(_cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self)
    }
}

static POSTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "Posted{WS}+([A-Za-z0-9_]+{WS}+[0-9]+,{WS}+[0-9]{{4}})"
    ))
    .expect("static")
});
static BY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?i-u:by){WS}+([A-Za-z0-9_]+)")).expect("static"));

/// `parseDate(text)`: "Posted March 5, 2024" as `YYYY-MM-DD`, empty when absent or invalid.
fn parse_posted(text: &str) -> String {
    let Some(m) = POSTED.captures(text) else {
        return String::new();
    };
    match parse_date(&m[1]) {
        Some(ms) => iso_date_from_millis(ms).unwrap_or_default(),
        None => String::new(),
    }
}

fn article_content(cx: &mut Cx, main: NodeId) -> Result<String, ExtractError> {
    let clone = cx.doc.clone_node(main, true);
    for el in cx
        .doc
        .query_selector_all(clone, r#"details.CommentBox, form, a[name^="Comm"]"#)?
    {
        cx.doc.remove(el);
    }
    // Trailing `<hr>` and `<br clear>` separate the article from its comments.
    let mut last = cx.doc.last_element_child(clone);
    while let Some(el) = last {
        let tag = cx.doc.tag_name(el).unwrap_or_default();
        let is_separator = tag == "HR" || (tag == "BR" && !attr_of(cx.doc, el, "clear").is_empty());
        if !is_separator {
            break;
        }
        let prev = cx.doc.previous_element_sibling(el);
        cx.doc.remove(el);
        last = prev;
    }
    Ok(cx.doc.inner_html(clone))
}

fn comment_depth(cx: &Cx, el: NodeId, root: NodeId) -> usize {
    let mut depth = 0;
    let mut parent = cx.doc.parent_element(el);
    while let Some(p) = parent {
        if p == root {
            break;
        }
        if cx.doc.tag_name(p).as_deref() == Some("DETAILS")
            && cx.doc.class_list_contains(p, "CommentBox")
        {
            depth += 1;
        }
        parent = cx.doc.parent_element(p);
    }
    depth
}

fn comment_content(cx: &mut Cx, boxed: NodeId, title: &str) -> Result<String, ExtractError> {
    let mut content = String::new();
    if !title.is_empty() {
        content.push_str(&format!("<p><strong>{}</strong></p>", escape_html(title)));
    }
    if let Some(formatted) = cx.doc.query_selector(boxed, ":scope > .FormattedComment")? {
        content.push_str(&cx.doc.inner_html(formatted));
        return Ok(content);
    }
    let temp = cx.doc.create_element("div");
    for child in cx.doc.child_nodes(boxed) {
        if cx.doc.is_element(child) {
            let tag = cx.doc.tag_name(child).unwrap_or_default();
            if tag == "SUMMARY"
                || tag == "DETAILS"
                || cx.doc.class_list_contains(child, "CommentReplyButton")
                || tag == "FORM"
                || (tag == "A" && attr_of(cx.doc, child, "name").starts_with("CommAnchor"))
                || (tag == "P" && trimmed(cx.doc, child).is_empty())
            {
                continue;
            }
        }
        let copy = cx.doc.clone_node(child, true);
        cx.doc.append_child(temp, copy)?;
    }
    let text = trim(&cx.doc.inner_html(temp)).to_string();
    if !text.is_empty() {
        content.push_str(&text);
    }
    Ok(content)
}

fn comment_data(cx: &mut Cx, boxed: NodeId, depth: usize) -> Result<Option<Comment>, ExtractError> {
    let Some(poster) = cx
        .doc
        .query_selector(boxed, ":scope > summary .CommentPoster")?
    else {
        return Ok(None);
    };
    let author = sel_text(cx.doc, poster, "b")?;
    let path = sel_attr(cx.doc, poster, r#"a[href^="/Articles/"]"#, "href")?;
    let url = if path.is_empty() {
        String::new()
    } else {
        format!("https://lwn.net{path}")
    };
    let date = parse_posted(&text_of(cx.doc, poster));
    let title = sel_text(cx.doc, boxed, ":scope > summary h3.CommentTitle")?;
    let parent_box = match cx.doc.parent_element(boxed) {
        Some(p) => cx.doc.closest(p, "details.CommentBox")?,
        None => None,
    };
    let parent_title = match parent_box {
        Some(p) => sel_text(cx.doc, p, ":scope > summary h3.CommentTitle")?,
        None => String::new(),
    };
    let unique = if !title.is_empty() && title != parent_title {
        title
    } else {
        String::new()
    };
    let content = comment_content(cx, boxed, &unique)?;
    Ok(Some(Comment {
        author,
        date,
        content,
        depth: Some(depth as f64),
        url: Some(url),
        score: None,
    }))
}

fn extract_comments(cx: &mut Cx, main: NodeId) -> Result<String, ExtractError> {
    let mut data = Vec::new();
    for boxed in cx.doc.query_selector_all(main, "details.CommentBox")? {
        let depth = comment_depth(cx, boxed, main);
        if let Some(c) = comment_data(cx, boxed, depth)? {
            data.push(c);
        }
    }
    Ok(if data.is_empty() {
        String::new()
    } else {
        build_comment_tree(&data)
    })
}

impl Extractor for LwnExtractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(cx.qs(".PageHeadline")?.is_some() && cx.qs(".ArticleText")?.is_some())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let main = cx.qs(".ArticleText main")?;
        let article = match main {
            Some(m) => article_content(cx, m)?,
            None => String::new(),
        };
        let comments = match main {
            Some(m) => extract_comments(cx, m)?,
            None => String::new(),
        };
        let content_html = build_content_html("lwn", &article, &comments);
        let byline = sel_text(cx.doc, cx.root, ".Byline")?;
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title: sel_text(cx.doc, cx.root, ".PageHeadline h1")?,
                author: BY
                    .captures(&byline)
                    .map(|m| m[1].to_string())
                    .unwrap_or_default(),
                site: "LWN.net".into(),
                published: parse_posted(&byline),
                description: sel_attr(
                    cx.doc,
                    cx.root,
                    r#"meta[property="og:description"]"#,
                    "content",
                )?,
                ..Variables::default()
            },
        })
    }
}

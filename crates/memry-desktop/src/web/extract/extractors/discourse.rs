//! `dist/extractors/discourse.js`.

use url::Url;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{Comment, build_comment_tree, build_content_html};
use crate::web::extract::utils::date::{iso_date_from_millis, iso_date_or_empty};
use crate::web::extract::utils::js::{parse_int, trim};

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, description_cut, sel_attr, sel_text, trimmed,
};

pub struct DiscourseExtractor {
    is_discourse: bool,
}

impl DiscourseExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let generator = sel_attr(cx.doc, cx.root, r#"meta[name="generator"]"#, "content")?;
        Ok(Self {
            is_discourse: generator.starts_with("Discourse"),
        })
    }
}

fn topic_title(cx: &mut Cx) -> Result<String, ExtractError> {
    if let Some(fancy) = cx.qs(".fancy-title")? {
        return Ok(trimmed(cx.doc, fancy));
    }
    if let Some(h1) = cx.qs("h1[data-topic-id]")? {
        let clone = cx.doc.clone_node(h1, true);
        for el in cx.doc.query_selector_all(clone, "svg, .topic-statuses")? {
            cx.doc.remove(el);
        }
        return Ok(trimmed(cx.doc, clone));
    }
    Ok(String::new())
}

fn author_of(cx: &Cx, post: NodeId) -> Result<String, ExtractError> {
    let Some(link) = cx.doc.query_selector(post, ".names a[data-user-card]")? else {
        return Ok(String::new());
    };
    let card = attr_of(cx.doc, link, "data-user-card");
    Ok(if card.is_empty() {
        trimmed(cx.doc, link)
    } else {
        card
    })
}

fn post_date(cx: &Cx, post: NodeId) -> Result<String, ExtractError> {
    let Some(el) = cx.doc.query_selector(post, ".relative-date[data-time]")? else {
        return Ok(String::new());
    };
    let raw = attr_of(cx.doc, el, "data-time");
    let time = parse_int(if raw.is_empty() { "0" } else { &raw }).unwrap_or(0);
    if time == 0 {
        return Ok(String::new());
    }
    Ok(iso_date_from_millis(time as f64).unwrap_or_default())
}

fn permalink(cx: &Cx, post: NodeId) -> Result<String, ExtractError> {
    let href = sel_attr(cx.doc, post, "a.post-date[href]", "href")?;
    if href.is_empty() {
        return Ok(String::new());
    }
    Ok(match Url::parse(cx.url) {
        Ok(base) => format!("{}{href}", base.origin().ascii_serialization()),
        Err(_) => href,
    })
}

fn post_text(cx: &Cx, post: NodeId) -> Result<String, ExtractError> {
    sel_text(cx.doc, post, ".cooked")
}

fn post_content(cx: &mut Cx, post: NodeId) -> Result<String, ExtractError> {
    let Some(cooked) = cx.doc.query_selector(post, ".cooked")? else {
        return Ok(String::new());
    };
    let clone = cx.doc.clone_node(cooked, true);
    for el in cx
        .doc
        .query_selector_all(clone, ".cooked-selection-barrier")?
    {
        cx.doc.remove(el);
    }
    for el in cx.doc.query_selector_all(clone, "a.anchor")? {
        cx.doc.remove(el);
    }
    Ok(cx.doc.inner_html(clone))
}

impl Extractor for DiscourseExtractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.is_discourse && cx.qs(".topic-post")?.is_some())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let title = topic_title(cx)?;
        let site_name = sel_attr(
            cx.doc,
            cx.root,
            r#"meta[property="og:site_name"]"#,
            "content",
        )?;
        let published = match cx.qs(r#"meta[property="article:published_time"]"#)? {
            Some(meta) => iso_date_or_empty(&attr_of(cx.doc, meta, "content")),
            None => String::new(),
        };
        let posts = cx.qsa(".topic-post")?;
        let op = posts
            .iter()
            .copied()
            .find(|&p| cx.doc.class_list_contains(p, "topic-owner"));
        let content = match op {
            Some(op) => post_content(cx, op)?,
            None => String::new(),
        };
        let op_author = match op {
            Some(op) => author_of(cx, op)?,
            None => String::new(),
        };
        let mut comment_data = Vec::new();
        for &post in posts.iter().filter(|&&p| Some(p) != op) {
            let likes = match cx.doc.query_selector(post, "button.like-count")? {
                Some(btn) => trimmed(cx.doc, btn),
                None => String::new(),
            };
            comment_data.push(Comment {
                author: author_of(cx, post)?,
                content: post_content(cx, post)?,
                date: post_date(cx, post)?,
                url: Some(permalink(cx, post)?).filter(|u| !u.is_empty()),
                score: Some(format!("{likes} likes")).filter(|_| !likes.is_empty()),
                depth: Some(0.0),
            });
        }
        let comments = if comment_data.is_empty() {
            String::new()
        } else {
            build_comment_tree(&comment_data)
        };
        let content_html = build_content_html("discourse", &content, &comments);
        let author = if op_author.is_empty() {
            match posts.first() {
                Some(&first) => author_of(cx, first)?,
                // `this.getAuthor(undefined)` throws in JS; `canExtract` guarantees a post.
                None => return Err(ExtractError::Js("TypeError: post is undefined".into())),
            }
        } else {
            op_author
        };
        let description = match op {
            Some(op) => description_cut(trim(&post_text(cx, op)?)),
            None => String::new(),
        };
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title,
                author,
                site: if site_name.is_empty() {
                    "Discourse".into()
                } else {
                    site_name
                },
                description,
                published,
                ..Variables::default()
            },
        })
    }
}

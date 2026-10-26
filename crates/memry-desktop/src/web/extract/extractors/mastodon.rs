//! `dist/extractors/mastodon.js`.

use url::Url;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{Comment, build_comment_tree, build_content_html};
use crate::web::extract::utils::date::iso_date_or_empty;
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::trim;

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, description_cut, post_title, sel_attr, sel_text,
    text_of, trimmed,
};

pub struct MastodonExtractor {
    main_post: Option<NodeId>,
    replies: Vec<NodeId>,
}

impl MastodonExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let main_post = cx.qs(".detailed-status__wrapper")?;
        let mut replies = Vec::new();
        for wrapper in cx.qsa(".status__wrapper")? {
            if cx
                .doc
                .query_selector(wrapper, ".status[data-id]")?
                .is_some()
            {
                replies.push(wrapper);
            }
        }
        Ok(Self { main_post, replies })
    }
}

fn full_handle(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    let text = sel_text(cx.doc, container, ".display-name__account")?;
    Ok(text.strip_prefix('@').unwrap_or(&text).to_string())
}

/// `replaceEmojiImages(container)`: emoji `<img>` become their alt text.
fn replace_emoji_images(cx: &mut Cx, container: NodeId) -> Result<(), ExtractError> {
    for img in cx.doc.query_selector_all(container, "img.emojione")? {
        let alt = attr_of(cx.doc, img, "alt");
        if alt.is_empty() {
            cx.doc.remove(img);
        } else {
            let text = cx.doc.create_text_node(&alt);
            cx.doc.replace_with(img, &[text])?;
        }
    }
    Ok(())
}

fn display_name(cx: &mut Cx, container: NodeId) -> Result<String, ExtractError> {
    let Some(name) = cx.doc.query_selector(container, ".display-name__html")? else {
        return Ok(String::new());
    };
    let clone = cx.doc.clone_node(name, true);
    replace_emoji_images(cx, clone)?;
    Ok(trimmed(cx.doc, clone))
}

fn extract_text_content(cx: &mut Cx, content: Option<NodeId>) -> Result<String, ExtractError> {
    let Some(content) = content else {
        return Ok(String::new());
    };
    let Some(text) = cx.doc.query_selector(content, ".status__content__text")? else {
        return Ok(String::new());
    };
    let clone = cx.doc.clone_node(text, true);
    replace_emoji_images(cx, clone)?;
    for el in cx.doc.query_selector_all(clone, "span.invisible")? {
        cx.doc.remove(el);
    }
    for el in cx.doc.query_selector_all(clone, "span")? {
        let children = cx.doc.child_nodes(el);
        cx.doc.replace_with(el, &children)?;
    }
    let html = cx.doc.inner_html(clone);
    let value = if html.is_empty() {
        text_of(cx.doc, clone)
    } else {
        html
    };
    Ok(trim(&value).to_string())
}

fn extract_images(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    let Some(gallery) = cx.doc.query_selector(container, ".media-gallery")? else {
        return Ok(String::new());
    };
    let mut images = Vec::new();
    for link in cx
        .doc
        .query_selector_all(gallery, ".media-gallery__item-thumbnail")?
    {
        let href = attr_of(cx.doc, link, "href");
        let alt = sel_attr(cx.doc, link, "img", "alt")?;
        if !href.is_empty() {
            images.push(format!(
                "<img src=\"{}\" alt=\"{}\" />",
                escape_html(&href),
                escape_html(&alt)
            ));
        }
    }
    Ok(images.join("\n"))
}

fn extract_link_card(cx: &Cx, container: NodeId) -> Result<String, ExtractError> {
    let Some(card) = cx.doc.query_selector(container, "a.status-card[href]")? else {
        return Ok(String::new());
    };
    let href = attr_of(cx.doc, card, "href");
    let title = sel_text(cx.doc, card, ".status-card__title")?;
    let description = sel_text(cx.doc, card, ".status-card__description")?;
    if title.is_empty() && href.is_empty() {
        return Ok(String::new());
    }
    let mut html = String::new();
    if let Some(img) = cx.doc.query_selector(card, ".status-card__image-image")? {
        let src = attr_of(cx.doc, img, "src");
        if !src.is_empty() {
            html.push_str(&format!(
                "<a href=\"{}\"><img src=\"{}\" alt=\"{}\" /></a>\n",
                escape_html(&href),
                escape_html(&src),
                escape_html(&title)
            ));
        }
    }
    let label = if title.is_empty() { &href } else { &title };
    html.push_str(&format!(
        "<p><a href=\"{}\">{}</a></p>",
        escape_html(&href),
        escape_html(label)
    ));
    if !description.is_empty() {
        html.push_str(&format!("\n<p>{}</p>", escape_html(&description)));
    }
    Ok(html)
}

fn extract_post_content(cx: &mut Cx, container: NodeId) -> Result<String, ExtractError> {
    let mut parts = Vec::new();
    let content = cx.doc.query_selector(container, ".status__content")?;
    let text = extract_text_content(cx, content)?;
    if !text.is_empty() {
        parts.push(text);
    }
    let images = extract_images(cx, container)?;
    if !images.is_empty() {
        parts.push(images);
    }
    let card = extract_link_card(cx, container)?;
    if !card.is_empty() {
        parts.push(card);
    }
    Ok(parts.join("\n"))
}

fn reply_date(cx: &Cx, wrapper: NodeId) -> Result<String, ExtractError> {
    Ok(match cx.doc.query_selector(wrapper, "time[datetime]")? {
        Some(time) => iso_date_or_empty(&attr_of(cx.doc, time, "datetime")),
        None => String::new(),
    })
}

fn reply_permalink(cx: &Cx, wrapper: NodeId) -> Result<String, ExtractError> {
    let href = sel_attr(cx.doc, wrapper, "a.status__relative-time[href]", "href")?;
    if href.is_empty() {
        return Ok(String::new());
    }
    Ok(match Url::parse(cx.url) {
        Ok(_) if href.starts_with("http") => href,
        Ok(base) => format!("{}{href}", base.origin().ascii_serialization()),
        Err(_) => href,
    })
}

impl MastodonExtractor {
    fn published_date(&self, cx: &Cx) -> Result<String, ExtractError> {
        if let Some(meta) = cx.qs(r#"meta[property="og:published_time"]"#)?
            && let Ok(date) = crate::web::extract::utils::date::iso_date_from_text(&attr_of(
                cx.doc, meta, "content",
            ))
        {
            return Ok(date);
        }
        if let Some(post) = self.main_post
            && let Some(time) = cx.doc.query_selector(post, "time[datetime]")?
            && let Ok(date) = crate::web::extract::utils::date::iso_date_from_text(&attr_of(
                cx.doc, time, "datetime",
            ))
        {
            return Ok(date);
        }
        Ok(String::new())
    }

    fn extract_comments(&self, cx: &mut Cx, items: &[NodeId]) -> Result<String, ExtractError> {
        if items.is_empty() {
            return Ok(String::new());
        }
        let mut depth = 0.0;
        let mut data = Vec::new();
        for (index, &wrapper) in items.iter().enumerate() {
            let handle = full_handle(cx, wrapper)?;
            let name = display_name(cx, wrapper)?;
            let content = extract_post_content(cx, wrapper)?;
            let date = reply_date(cx, wrapper)?;
            let permalink = reply_permalink(cx, wrapper)?;
            if cx
                .doc
                .query_selector(wrapper, ".status--first-in-thread")?
                .is_some()
                || index == 0
            {
                depth = 0.0;
            } else {
                depth += 1.0;
            }
            data.push(Comment {
                author: if name.is_empty() {
                    format!("@{handle}")
                } else {
                    format!("{name} @{handle}")
                },
                date,
                content,
                depth: Some(depth),
                url: Some(permalink).filter(|u| !u.is_empty()),
                score: None,
            });
        }
        Ok(build_comment_tree(&data))
    }
}

impl Extractor for MastodonExtractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        if self.main_post.is_none() {
            return Ok(false);
        }
        if cx.doc.get_element_by_id(cx.root, "mastodon").is_some() {
            return Ok(true);
        }
        if let Some(state) = cx.qs("script#initial-state")? {
            let text = text_of(cx.doc, state);
            if text.contains("mastodon/mastodon") || text.contains("\"mastodon\"") {
                return Ok(true);
            }
        }
        for link in cx.qsa(r#"link[rel="stylesheet"]"#)? {
            if attr_of(cx.doc, link, "href").contains("mastodon") {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let main = self
            .main_post
            .ok_or_else(|| ExtractError::Js("TypeError: mainPost is null".into()))?;
        let main_full_handle = full_handle(cx, main)?;
        let main_handle = main_full_handle
            .split('@')
            .next()
            .unwrap_or_default()
            .to_string();
        let name = display_name(cx, main)?;

        let mut thread_items = Vec::new();
        let mut reply_items = Vec::new();
        let mut thread_ended = false;
        for &status in &self.replies {
            let handle = full_handle(cx, status)?;
            let handle = handle.split('@').next().unwrap_or_default();
            if !thread_ended && handle == main_handle {
                thread_items.push(status);
            } else {
                thread_ended = true;
                reply_items.push(status);
            }
        }

        let mut parts = vec![extract_post_content(cx, main)?];
        for item in thread_items {
            parts.push(extract_post_content(cx, item)?);
        }
        let post_content = parts
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n<hr>\n");
        let comments = self.extract_comments(cx, &reply_items)?;
        let content_html = build_content_html("mastodon", &post_content, &comments);
        let author = if name.is_empty() {
            format!("@{main_full_handle}")
        } else {
            name
        };
        let description = match cx.doc.query_selector(main, ".status__content__text")? {
            Some(el) => description_cut(trim(&text_of(cx.doc, el))),
            None => String::new(),
        };
        let published = self.published_date(cx)?;
        let site_name = sel_attr(
            cx.doc,
            cx.root,
            r#"meta[property="og:site_name"]"#,
            "content",
        )?;
        let site = if site_name.is_empty() {
            "Mastodon".to_string()
        } else {
            site_name
        };
        let title = post_title(&author, &site);
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title,
                author,
                site,
                description,
                published,
                ..Variables::default()
            },
        })
    }
}

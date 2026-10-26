//! `dist/extractors/linkedin.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{
    Comment, QuotedPost, build_comment_tree, build_content_html, build_quoted_post,
};
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::{WS, trim};

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, description_cut, post_title, sel_attr, text_of,
    trimmed,
};

const COMMENTARY: &str = ".update-components-text.update-components-update-v2__commentary";
const QUOTED_WRAPPER: &str = ".feed-shared-update-v2__update-content-wrapper";

pub struct LinkedInExtractor {
    post: Option<NodeId>,
}

impl LinkedInExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            post: cx.qs(r#"[role="article"].feed-shared-update-v2"#)?,
        })
    }
}

/// `getVisibleText(el, alsoRemove)`.
fn visible_text(
    cx: &mut Cx,
    el: NodeId,
    also_remove: Option<&str>,
) -> Result<String, ExtractError> {
    let clone = cx.doc.clone_node(el, true);
    let selector = match also_remove {
        Some(extra) => format!(".visually-hidden, {extra}"),
        None => ".visually-hidden".to_string(),
    };
    for e in cx.doc.query_selector_all(clone, &selector)? {
        cx.doc.remove(e);
    }
    Ok(trimmed(cx.doc, clone))
}

static COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<!--[^\n\r\x{2028}\x{2029}]*?-->").expect("static pattern"));
static PARAGRAPH_BREAK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?:<br{WS}*/?>{WS}*){{2,}}|\n{{2,}}")).expect("static pattern")
});
static BR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"<br{WS}*/?>")).expect("static pattern"));
static RUNS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static pattern"));

/// `cleanTextContent(el)`: links keep `href` and text, wrappers unwrap, `<br><br>` splits
/// paragraphs.
fn clean_text(cx: &mut Cx, el: NodeId) -> Result<String, ExtractError> {
    let clone = cx.doc.clone_node(el, true);
    for e in cx.doc.query_selector_all(
        clone,
        ".visually-hidden, .feed-shared-inline-show-more-text__see-more-less-toggle",
    )? {
        cx.doc.remove(e);
    }
    for link in cx.doc.query_selector_all(clone, "a")? {
        let href = attr_of(cx.doc, link, "href");
        let text = trimmed(cx.doc, link);
        if !href.is_empty() && !text.is_empty() {
            let clean = cx.doc.create_element("a");
            cx.doc.set_attribute(clean, "href", &href);
            cx.doc.set_text_content(clean, &text)?;
            cx.doc.replace_with(link, &[clean])?;
        } else {
            let text_node = cx.doc.create_text_node(&text_of(cx.doc, link));
            cx.doc.replace_with(link, &[text_node])?;
        }
    }
    for e in cx.doc.query_selector_all(clone, "span, div")? {
        let children = cx.doc.child_nodes(e);
        cx.doc.replace_with(e, &children)?;
    }
    let html = trim(&cx.doc.inner_html(clone)).to_string();
    let html = COMMENT.replace_all(&html, "");
    let paragraphs: Vec<String> = PARAGRAPH_BREAK
        .split(&html)
        .map(|p| trim(&RUNS.replace_all(&BR.replace_all(p, " "), " ")).to_string())
        .filter(|p| !p.is_empty())
        .collect();
    Ok(paragraphs
        .iter()
        .map(|p| format!("<p>{p}</p>"))
        .collect::<Vec<_>>()
        .join("\n"))
}

fn absolute(href: &str) -> String {
    if href.starts_with("http") {
        href.to_string()
    } else {
        format!("https://www.linkedin.com{href}")
    }
}

impl LinkedInExtractor {
    fn commentary(&self, cx: &Cx, post: NodeId) -> Result<Option<NodeId>, ExtractError> {
        let wrapper = cx.doc.query_selector(post, QUOTED_WRAPPER)?;
        let text = cx.doc.query_selector(post, COMMENTARY)?;
        Ok(text.filter(|&t| wrapper.is_none_or(|w| !cx.doc.contains(w, t))))
    }

    fn quoted_post(&self, cx: &mut Cx, wrapper: Option<NodeId>) -> Result<String, ExtractError> {
        let Some(wrapper) = wrapper else {
            return Ok(String::new());
        };
        let author = match cx
            .doc
            .query_selector(wrapper, ".update-components-actor__title")?
        {
            Some(title) => visible_text(
                cx,
                title,
                Some(
                    ".update-components-actor__supplementary-actor-info, .text-view-model__verified-icon",
                ),
            )?,
            None => String::new(),
        };
        let mut date = String::new();
        if let Some(sub) = cx
            .doc
            .query_selector(wrapper, ".update-components-actor__sub-description")?
        {
            let visible = cx.doc.query_selector(sub, r#"[aria-hidden="true"]"#)?;
            let raw = trimmed(cx.doc, visible.unwrap_or(sub));
            static LEADING: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^[0-9]+[A-Za-z0-9_]+").expect("static pattern"));
            date = LEADING
                .find(&raw)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
        }
        let content = match cx.doc.query_selector(wrapper, COMMENTARY)? {
            Some(el) => clean_text(cx, el)?,
            None => String::new(),
        };
        let post_url = sel_attr(
            cx.doc,
            wrapper,
            "a.update-components-mini-update-v2__link-to-details-page",
            "href",
        )?;
        let url = if post_url.is_empty() {
            String::new()
        } else {
            absolute(&post_url)
                .split('?')
                .next()
                .unwrap_or_default()
                .to_string()
        };
        Ok(build_quoted_post(&QuotedPost {
            author,
            date,
            content,
            url,
        }))
    }

    fn images(&self, cx: &Cx, post: NodeId) -> Result<String, ExtractError> {
        let mut images = Vec::new();
        for img in cx
            .doc
            .query_selector_all(post, ".update-components-image img, .feed-shared-image img")?
        {
            let src = attr_of(cx.doc, img, "src");
            let alt = attr_of(cx.doc, img, "alt");
            if !src.is_empty()
                && !src.contains("profile-displayphoto")
                && !src.contains("avm-avatar")
            {
                images.push(format!(
                    "<img src=\"{}\" alt=\"{}\" />",
                    escape_html(&src),
                    escape_html(&alt)
                ));
            }
        }
        Ok(images.join("\n"))
    }

    fn video(&self, cx: &Cx, post: NodeId) -> Result<String, ExtractError> {
        let Some(video) = cx
            .doc
            .query_selector(post, ".update-components-linkedin-video video[poster]")?
        else {
            return Ok(String::new());
        };
        let poster = attr_of(cx.doc, video, "poster");
        Ok(format!(
            "<img src=\"{}\" alt=\"Video thumbnail\" />",
            escape_html(&poster)
        ))
    }

    fn comment_data(
        &self,
        cx: &mut Cx,
        comment: NodeId,
        depth: f64,
    ) -> Result<Option<Comment>, ExtractError> {
        let author = match cx
            .doc
            .query_selector(comment, ".comments-comment-meta__description-title")?
        {
            Some(el) => trimmed(cx.doc, el),
            None => String::new(),
        };
        if author.is_empty() {
            return Ok(None);
        }
        let content = match cx.doc.query_selector(
            comment,
            ".comments-comment-entity__content .update-components-text",
        )? {
            Some(el) => clean_text(cx, el)?,
            None => String::new(),
        };
        let date = match cx
            .doc
            .query_selector(comment, "time.comments-comment-meta__data")?
        {
            Some(el) => trimmed(cx.doc, el),
            None => String::new(),
        };
        let href = sel_attr(
            cx.doc,
            comment,
            "a.comments-comment-meta__description-container",
            "href",
        )?;
        let href = href.split('?').next().unwrap_or_default().to_string();
        let url = if href.is_empty() {
            String::new()
        } else {
            absolute(&href)
        };
        let reactions = match cx.doc.query_selector(
            comment,
            ".comments-comment-social-bar__reactions-count--cr span.v-align-middle",
        )? {
            Some(el) => trimmed(cx.doc, el),
            None => String::new(),
        };
        Ok(Some(Comment {
            author,
            date,
            content,
            depth: Some(depth),
            url: Some(url).filter(|u| !u.is_empty()),
            score: (!reactions.is_empty()).then(|| format!("{reactions} reactions")),
        }))
    }

    fn comments(&self, cx: &mut Cx, post: NodeId) -> Result<String, ExtractError> {
        let mut data = Vec::new();
        for comment in cx.doc.query_selector_all(
            post,
            "article.comments-comment-entity:not(.comments-comment-entity--reply)",
        )? {
            if let Some(d) = self.comment_data(cx, comment, 0.0)? {
                data.push(d);
            }
            for reply in cx.doc.query_selector_all(
                comment,
                ".comments-replies-list article.comments-comment-entity--reply",
            )? {
                if let Some(d) = self.comment_data(cx, reply, 1.0)? {
                    data.push(d);
                }
            }
        }
        Ok(if data.is_empty() {
            String::new()
        } else {
            build_comment_tree(&data)
        })
    }

    fn author_name(&self, cx: &mut Cx, post: NodeId) -> Result<String, ExtractError> {
        match cx
            .doc
            .query_selector(post, ".update-components-actor__title")?
        {
            Some(el) => visible_text(
                cx,
                el,
                Some(
                    ".text-view-model__verified-icon, .update-components-actor__supplementary-actor-info",
                ),
            ),
            None => Ok(String::new()),
        }
    }
}

impl Extractor for LinkedInExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.post.is_some())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let Some(post) = self.post else {
            return Err(ExtractError::Js("TypeError: postArticle is null".into()));
        };
        let wrapper = cx.doc.query_selector(post, QUOTED_WRAPPER)?;
        let text = match self.commentary(cx, post)? {
            Some(el) => clean_text(cx, el)?,
            None => String::new(),
        };
        let images = self.images(cx, post)?;
        let video = self.video(cx, post)?;
        let quoted = self.quoted_post(cx, wrapper)?;
        let mut post_content = text;
        for part in [images, video, quoted] {
            if !part.is_empty() {
                post_content.push('\n');
                post_content.push_str(&part);
            }
        }
        let comments = self.comments(cx, post)?;
        let content_html = build_content_html("linkedin", &post_content, &comments);
        let author = self.author_name(cx, post)?;
        let description = match self.commentary(cx, post)? {
            Some(el) => description_cut(&visible_text(cx, el, None)?),
            None => String::new(),
        };
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title: post_title(&author, "LinkedIn"),
                author,
                site: "LinkedIn".into(),
                description,
                ..Variables::default()
            },
        })
    }
}

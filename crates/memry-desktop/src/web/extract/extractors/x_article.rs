//! `dist/extractors/x-article.js`: long-form X articles (Draft.js markup).
//!
//! `repairSurrogatePairs` joins a surrogate pair that the markup split across two text nodes.
//! A Rust string cannot hold half a pair (the parser turns it into U+FFFD, and the vectors are
//! well-formed text), so that pass has nothing to do here.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, trim, utf16_len, utf16_slice};

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, sel_attr, sel_text, text_of, trimmed,
};

const READ_VIEW: &str = r#"[data-testid="twitterArticleReadView"]"#;
const CONTAINER: &str = r#"[data-testid="twitterArticleRichTextView"]"#;
const IMAGES: &str = r#"[data-testid="tweetPhoto"] img"#;

pub struct XArticleExtractor {
    container: Option<NodeId>,
}

static URL_AUTHOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/([a-zA-Z0-9_][a-zA-Z0-9_]{0,14})/(?:article|status)/[0-9]+").expect("static")
});
static OG_AUTHOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:\([0-9]+\){WS}+)?([^\n\r\x{{2028}}\x{{2029}}]+?){WS}+on{WS}+X{WS}*:"
    ))
    .expect("static")
});
static LANGUAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"language-([A-Za-z0-9_]+)").expect("static pattern"));
static NAME_PARAM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&name=[A-Za-z0-9_]+").expect("static pattern"));
static RUNS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static pattern"));

impl XArticleExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            container: cx.qs(CONTAINER)?,
        })
    }

    fn author_from_url(cx: &Cx) -> Result<String, ExtractError> {
        if let Some(m) = URL_AUTHOR.captures(cx.url) {
            return Ok(format!("@{}", &m[1]));
        }
        let og = sel_attr(cx.doc, cx.root, r#"meta[property="og:title"]"#, "content")?;
        Ok(OG_AUTHOR
            .captures(&og)
            .map(|m| trim(&m[1]).to_string())
            .unwrap_or_else(|| "Unknown".to_string()))
    }

    fn author(cx: &Cx) -> Result<String, ExtractError> {
        let Some(container) = cx.qs(r#"[itemprop="author"]"#)? else {
            return Self::author_from_url(cx);
        };
        let name = sel_attr(cx.doc, container, r#"meta[itemprop="name"]"#, "content")?;
        let handle = sel_attr(
            cx.doc,
            container,
            r#"meta[itemprop="additionalName"]"#,
            "content",
        )?;
        if !name.is_empty() && !handle.is_empty() {
            return Ok(format!("{name} (@{handle})"));
        }
        if !name.is_empty() {
            return Ok(name);
        }
        if !handle.is_empty() {
            return Ok(handle);
        }
        Self::author_from_url(cx)
    }
}

/// `upgradeImageSrc(src)`.
fn upgrade_image_src(src: &str) -> String {
    if src.contains("&name=") {
        NAME_PARAM.replace(src, "&name=large").into_owned()
    } else if src.contains('?') {
        format!("{src}&name=large")
    } else {
        format!("{src}?name=large")
    }
}

fn clean_alt(alt: &str) -> String {
    let t = trim(&RUNS.replace_all(alt, " ")).to_string();
    if t.is_empty() { "Image".to_string() } else { t }
}

fn convert_embedded_tweets(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    for tweet in doc.query_selector_all(container, r#"[data-testid="simpleTweet"]"#)? {
        let blockquote = doc.create_element("blockquote");
        doc.set_attribute(blockquote, "class", "embedded-tweet");
        let user = doc.query_selector(tweet, r#"[data-testid="User-Name"]"#)?;
        let links = match user {
            Some(u) => doc.query_selector_all(u, "a")?,
            None => Vec::new(),
        };
        let full_name = links.first().map(|&l| trimmed(doc, l)).unwrap_or_default();
        let handle = links.get(1).map(|&l| trimmed(doc, l)).unwrap_or_default();
        let text = sel_text(doc, tweet, r#"[data-testid="tweetText"]"#)?;
        if !full_name.is_empty() || !handle.is_empty() {
            let cite = doc.create_element("cite");
            let label = if handle.is_empty() {
                full_name
            } else {
                format!("{full_name} {handle}")
            };
            doc.set_text_content(cite, &label)?;
            doc.append_child(blockquote, cite)?;
        }
        if !text.is_empty() {
            let p = doc.create_element("p");
            doc.set_text_content(p, &text)?;
            doc.append_child(blockquote, p)?;
        }
        doc.replace_with(tweet, &[blockquote])?;
    }
    Ok(())
}

fn convert_code_blocks(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    for block in doc.query_selector_all(container, r#"[data-testid="markdown-code-block"]"#)? {
        let (Some(_pre), Some(code)) = (
            doc.query_selector(block, "pre")?,
            doc.query_selector(block, "code")?,
        ) else {
            continue;
        };
        let language = match LANGUAGE.captures(&doc.class_name(code)) {
            Some(m) => m[1].to_string(),
            None => sel_text(doc, block, "span")?,
        };
        let new_pre = doc.create_element("pre");
        let new_code = doc.create_element("code");
        if !language.is_empty() {
            doc.set_attribute(new_code, "data-lang", &language);
            doc.set_attribute(new_code, "class", &format!("language-{language}"));
        }
        let text = text_of(doc, code);
        doc.set_text_content(new_code, &text)?;
        doc.append_child(new_pre, new_code)?;
        doc.replace_with(block, &[new_pre])?;
    }
    Ok(())
}

fn convert_headers(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    for header in doc.query_selector_all(container, "h1, h2, h3, h4, h5, h6")? {
        let level = doc
            .local_name(header)
            .map(str::to_lowercase)
            .unwrap_or_default();
        let text = trimmed(doc, header);
        if text.is_empty() {
            continue;
        }
        let new_header = doc.create_element(&level);
        doc.set_text_content(new_header, &text)?;
        doc.replace_with(header, &[new_header])?;
    }
    Ok(())
}

fn unwrap_linked_images(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    for img in doc.query_selector_all(container, IMAGES)? {
        let Some(anchor) = doc.closest(img, "a")? else {
            continue;
        };
        if !doc.contains(container, anchor) {
            continue;
        }
        let src = attr_of(doc, img, "src");
        let alt = clean_alt(&attr_of(doc, img, "alt"));
        let clean = doc.create_element("img");
        doc.set_attribute(clean, "src", &upgrade_image_src(&src));
        doc.set_attribute(clean, "alt", &alt);
        doc.replace_with(anchor, &[clean])?;
    }
    Ok(())
}

fn upgrade_image_quality(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    for img in doc.query_selector_all(container, IMAGES)? {
        let src = attr_of(doc, img, "src");
        if !src.is_empty() {
            doc.set_attribute(img, "src", &upgrade_image_src(&src));
        }
    }
    Ok(())
}

fn convert_bold_spans(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    for span in doc.query_selector_all(container, r#"span[style*="font-weight: bold"]"#)? {
        let strong = doc.create_element("strong");
        let text = text_of(doc, span);
        doc.set_text_content(strong, &text)?;
        doc.replace_with(span, &[strong])?;
    }
    Ok(())
}

/// The `processNode` of `convertDraftParagraphs`: text copies, `strong`, `a` and `code` are
/// rebuilt clean, anything else is flattened into its children.
fn process_node(doc: &mut Document, p: NodeId, node: NodeId) -> Result<(), ExtractError> {
    if doc.node_type(node) == 3 {
        let text = text_of(doc, node);
        let copy = doc.create_text_node(&text);
        doc.append_child(p, copy)?;
    } else if doc.is_element(node) {
        let tag = doc
            .local_name(node)
            .map(str::to_lowercase)
            .unwrap_or_default();
        match tag.as_str() {
            "strong" | "code" => {
                let el = doc.create_element(&tag);
                let text = text_of(doc, node);
                doc.set_text_content(el, &text)?;
                doc.append_child(p, el)?;
            }
            "a" => {
                let link = doc.create_element("a");
                let href = attr_of(doc, node, "href");
                doc.set_attribute(link, "href", &href);
                let text = text_of(doc, node);
                doc.set_text_content(link, &text)?;
                doc.append_child(p, link)?;
            }
            _ => {
                for child in doc.child_nodes(node) {
                    process_node(doc, p, child)?;
                }
            }
        }
    }
    Ok(())
}

fn convert_draft_paragraphs(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    for div in doc.query_selector_all(
        container,
        ".longform-unstyled, .public-DraftStyleDefault-block",
    )? {
        let p = doc.create_element("p");
        for child in doc.child_nodes(div) {
            process_node(doc, p, child)?;
        }
        doc.replace_with(div, &[p])?;
    }
    Ok(())
}

fn clean_content(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    convert_embedded_tweets(doc, container)?;
    convert_code_blocks(doc, container)?;
    convert_headers(doc, container)?;
    unwrap_linked_images(doc, container)?;
    upgrade_image_quality(doc, container)?;
    convert_bold_spans(doc, container)?;
    convert_draft_paragraphs(doc, container)?;
    for el in doc.query_selector_all(container, "[data-offset-key]")? {
        doc.remove_attribute(el, "data-offset-key");
    }
    Ok(())
}

impl XArticleExtractor {
    fn header_image(&self, cx: &Cx) -> Result<String, ExtractError> {
        let Some(read_view) = cx.qs(READ_VIEW)? else {
            return Ok(String::new());
        };
        let Some(photo) = cx.doc.query_selector(read_view, IMAGES)? else {
            return Ok(String::new());
        };
        if self.container.is_some_and(|c| cx.doc.contains(c, photo)) {
            return Ok(String::new());
        }
        let src = attr_of(cx.doc, photo, "src");
        if src.is_empty() {
            return Ok(String::new());
        }
        let alt = clean_alt(&attr_of(cx.doc, photo, "alt"));
        Ok(format!(
            "<img src=\"{}\" alt=\"{alt}\">",
            upgrade_image_src(&src)
        ))
    }
}

impl Extractor for XArticleExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.container.is_some())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let title = match cx.qs(r#"[data-testid="twitter-article-title"]"#)? {
            Some(el) => Some(trimmed(cx.doc, el)).filter(|t| !t.is_empty()),
            None => None,
        }
        .unwrap_or_else(|| "Untitled X Article".to_string());
        let author = Self::author(cx)?;
        let container = self
            .container
            .ok_or_else(|| ExtractError::Js("TypeError: articleContainer is null".into()))?;
        let clone = cx.doc.clone_node(container, true);
        clean_content(cx.doc, clone)?;
        let header = self.header_image(cx)?;
        let content_html = format!(
            "<article class=\"x-article\">{header}{}</article>",
            cx.doc.inner_html(clone)
        );
        let text = trimmed(cx.doc, container);
        let description = format!(
            "{}{}",
            utf16_slice(&text, 0, 140),
            if utf16_len(&text) > 140 { "..." } else { "" }
        );
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title,
                author,
                site: "X (Twitter)".into(),
                description,
                ..Variables::default()
            },
        })
    }
}

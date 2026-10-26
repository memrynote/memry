//! `ConversationExtractor` (`dist/extractors/_conversation.js`): chat transcripts are rebuilt
//! as message markup and run through a nested Defuddle on a scratch document.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::defuddle::Defuddle;
use crate::web::extract::dom::Document;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{trim, utf16_len, utf16_slice};

use super::base::{Cx, Extracted, Variables};

#[derive(Clone)]
pub struct Message {
    pub author: String,
    pub content: String,
    /// The `data-*` attributes of the message block, in order.
    pub metadata: Vec<(&'static str, String)>,
}

pub struct Footnote {
    pub url: String,
    pub text: String,
}

pub struct ConversationMeta {
    pub title: String,
    pub site: &'static str,
    pub description: String,
}

pub trait Conversation {
    fn extract_messages(&mut self, cx: &mut Cx) -> Result<Vec<Message>, ExtractError>;
    fn get_metadata(&mut self, cx: &mut Cx) -> Result<ConversationMeta, ExtractError>;
    fn get_footnotes(&self) -> &[Footnote] {
        &[]
    }
}

/// `text.length > 50 ? text.slice(0, 50) + '...' : text`, the title of a conversation that has
/// no page title.
pub fn truncated_title(text: &str) -> String {
    if utf16_len(text) > 50 {
        format!("{}...", utf16_slice(text, 0, 50))
    } else {
        text.to_string()
    }
}

/// `document.title?.trim()`.
pub fn page_title(cx: &mut Cx) -> String {
    trim(&crate::web::extract::utils::dom::document_title(
        cx.doc, cx.root,
    ))
    .to_string()
}

static HAS_PARAGRAPH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:<p)[^>]*>(?s:.)*?(?i-u:</p>)").expect("static pattern"));

/// `createContentHtml(messages, footnotes)`.
fn create_content_html(messages: &[Message], footnotes: &[Footnote]) -> String {
    let rendered: Vec<String> = messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let content = if HAS_PARAGRAPH.is_match(&message.content) {
                message.content.clone()
            } else {
                format!("<p>{}</p>", message.content)
            };
            let data = message
                .metadata
                .iter()
                .map(|(key, value)| format!("data-{key}=\"{value}\""))
                .collect::<Vec<_>>()
                .join(" ");
            let separator = if index + 1 < messages.len() { "\n<hr>" } else { "" };
            format!(
                "\n\t\t\t<div class=\"message message-{}\" {data}>\n\t\t\t\t<div class=\"message-header\">\n\t\t\t\t\t<p class=\"message-author\"><strong>{}</strong></p>\n\t\t\t\t\t\n\t\t\t\t</div>\n\t\t\t\t<div class=\"message-content\">\n\t\t\t\t\t{content}\n\t\t\t\t</div>\n\t\t\t</div>{separator}",
                message.author.to_lowercase(),
                message.author,
            )
        })
        .collect();
    let messages_html = trim(&rendered.join("\n")).to_string();
    let footnotes_html = if footnotes.is_empty() {
        String::new()
    } else {
        let items: String = footnotes
            .iter()
            .enumerate()
            .map(|(index, f)| {
                let n = index + 1;
                format!(
                    "\n\t\t\t\t\t\t<li class=\"footnote\" id=\"fn:{n}\">\n\t\t\t\t\t\t\t<p>\n\t\t\t\t\t\t\t\t<a href=\"{}\" target=\"_blank\">{}</a>&nbsp;<a href=\"#fnref:{n}\" class=\"footnote-backref\">↩</a>\n\t\t\t\t\t\t\t</p>\n\t\t\t\t\t\t</li>\n\t\t\t\t\t",
                    f.url, f.text
                )
            })
            .collect();
        format!(
            "\n\t\t\t<div id=\"footnotes\">\n\t\t\t\t<ol>\n\t\t\t\t\t{items}\n\t\t\t\t</ol>\n\t\t\t</div>"
        )
    };
    trim(&format!("{messages_html}\n{footnotes_html}")).to_string()
}

/// `ConversationExtractor.extract()`.
pub fn extract_conversation(
    conversation: &mut dyn Conversation,
    cx: &mut Cx,
) -> Result<Extracted, ExtractError> {
    let messages = conversation.extract_messages(cx)?;
    let metadata = conversation.get_metadata(cx)?;
    let raw = create_content_html(&messages, conversation.get_footnotes());

    // `createTemporaryDocument()`: linkedom has no `implementation`, so the scratch document
    // comes from `DOMParser`.
    let mut temp = Document::parse_html("<!doctype html><html><body></body></html>");
    let temp_root = temp.root();
    let container = temp.create_element("article");
    let fragment = temp.parse_fragment(&raw);
    temp.append_child(container, fragment)?;
    let body = temp
        .body_of(temp_root)
        .ok_or_else(|| ExtractError::Dom("the scratch document has no body".into()))?;
    temp.append_child(body, container)?;
    let defuddled = Defuddle::new(temp, "about:blank").parse()?;

    let description = if metadata.description.is_empty() {
        format!(
            "{} conversation with {} messages",
            metadata.site,
            messages.len()
        )
    } else {
        metadata.description
    };
    Ok(Extracted {
        content_html: defuddled.content,
        content_selector: None,
        variables: Variables {
            title: if metadata.title.is_empty() {
                "Conversation".to_string()
            } else {
                metadata.title
            },
            site: metadata.site.to_string(),
            description,
            ..Variables::default()
        },
    })
}

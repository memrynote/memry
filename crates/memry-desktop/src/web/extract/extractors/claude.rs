//! `dist/extractors/claude.js`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::trim;

use super::base::{Cx, Extracted, Extractor, attr_of, sel_text, text_of};
use super::conversation::{
    Conversation, ConversationMeta, Message, extract_conversation, page_title, truncated_title,
};

const ARTICLES: &str = r#"div[data-testid="user-message"], div[data-testid="assistant-message"], div.font-claude-response"#;

pub struct ClaudeExtractor {
    articles: Vec<NodeId>,
}

impl ClaudeExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            articles: cx.qsa(ARTICLES)?,
        })
    }

    fn get_title(&self, cx: &mut Cx) -> Result<String, ExtractError> {
        let page = page_title(cx);
        if !page.is_empty() && page != "Claude" {
            return Ok(page.strip_suffix(" - Claude").unwrap_or(&page).to_string());
        }
        let header = sel_text(cx.doc, cx.root, "header .font-tiempos")?;
        if !header.is_empty() {
            return Ok(header);
        }
        if let Some(&first) = self.articles.first()
            && let Some(user) = cx
                .doc
                .query_selector(first, r#"[data-testid="user-message"]"#)?
        {
            return Ok(truncated_title(&text_of(cx.doc, user)));
        }
        Ok("Claude Conversation".to_string())
    }
}

static EMPTY_P: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"<p[^>]*>(?:[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}])*</p>").expect("static pattern")
});

impl Conversation for ClaudeExtractor {
    fn extract_messages(&mut self, cx: &mut Cx) -> Result<Vec<Message>, ExtractError> {
        let mut messages = Vec::new();
        for &article in &self.articles {
            let (role, content) = if cx.doc.has_attribute(article, "data-testid") {
                if attr_of(cx.doc, article, "data-testid") == "user-message" {
                    ("you", cx.doc.inner_html(article))
                } else {
                    continue;
                }
            } else if cx.doc.class_list_contains(article, "font-claude-response") {
                let body = cx
                    .doc
                    .query_selector(article, ".standard-markdown")?
                    .unwrap_or(article);
                ("assistant", cx.doc.inner_html(body))
            } else {
                continue;
            };
            if content.is_empty() {
                continue;
            }
            let content = EMPTY_P
                .replace_all(&content.replace('\u{200B}', ""), "")
                .into_owned();
            messages.push(Message {
                author: if role == "you" { "You" } else { "Claude" }.to_string(),
                content: trim(&content).to_string(),
                metadata: vec![("role", role.to_string())],
            });
        }
        Ok(messages)
    }

    fn get_metadata(&mut self, cx: &mut Cx) -> Result<ConversationMeta, ExtractError> {
        let title = self.get_title(cx)?;
        let count = self.extract_messages(cx)?.len();
        Ok(ConversationMeta {
            title,
            site: "Claude",
            description: format!("Claude conversation with {count} messages"),
        })
    }
}

impl Extractor for ClaudeExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(!self.articles.is_empty())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        extract_conversation(self, cx)
    }
}

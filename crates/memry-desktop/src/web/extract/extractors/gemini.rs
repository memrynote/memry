//! `dist/extractors/gemini.js`.

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::trim;

use super::base::{Cx, Extracted, Extractor, sel_text, text_of};
use super::conversation::{
    Conversation, ConversationMeta, Footnote, Message, extract_conversation, page_title,
    truncated_title,
};

pub struct GeminiExtractor {
    containers: Vec<NodeId>,
    footnotes: Vec<Footnote>,
    message_count: Option<usize>,
}

impl GeminiExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            containers: cx.qsa("div.conversation-container")?,
            footnotes: Vec::new(),
            message_count: None,
        })
    }

    /// `extractSources`: the source links are read behind `link instanceof HTMLAnchorElement`.
    /// `HTMLAnchorElement` is not a global in Node, so evaluating it throws a `ReferenceError`
    /// on every page that has a `browse-item`.
    fn extract_sources(&mut self, cx: &mut Cx) -> Result<(), ExtractError> {
        if !cx.qsa("browse-item")?.is_empty() {
            return Err(ExtractError::Js(
                "ReferenceError: HTMLAnchorElement is not defined".into(),
            ));
        }
        Ok(())
    }

    fn get_title(&self, cx: &mut Cx) -> Result<String, ExtractError> {
        let page = page_title(cx);
        if !page.is_empty() && page != "Gemini" && !page.contains("Gemini") {
            return Ok(page);
        }
        let research = sel_text(cx.doc, cx.root, ".title-text")?;
        if !research.is_empty() {
            return Ok(research);
        }
        if let Some(&first) = self.containers.first()
            && let Some(query) = cx.doc.query_selector(first, ".query-text")?
        {
            return Ok(truncated_title(&text_of(cx.doc, query)));
        }
        Ok("Gemini Conversation".to_string())
    }
}

impl Conversation for GeminiExtractor {
    fn extract_messages(&mut self, cx: &mut Cx) -> Result<Vec<Message>, ExtractError> {
        self.message_count = Some(0);
        let mut messages = Vec::new();
        self.extract_sources(cx)?;
        for &container in &self.containers.clone() {
            if let Some(query) = cx.doc.query_selector(container, "user-query")?
                && let Some(text) = cx.doc.query_selector(query, ".query-text")?
            {
                messages.push(Message {
                    author: "You".into(),
                    content: trim(&cx.doc.inner_html(text)).to_string(),
                    metadata: vec![("role", "user".into())],
                });
            }
            if let Some(response) = cx.doc.query_selector(container, "model-response")? {
                let regular = cx
                    .doc
                    .query_selector(response, ".model-response-text .markdown")?;
                let extended = cx
                    .doc
                    .query_selector(response, "#extended-response-markdown-content")?;
                if let Some(element) = extended.or(regular) {
                    let content = cx.doc.inner_html(element);
                    let temp = cx.doc.create_element("div");
                    let fragment = cx.doc.parse_fragment(&content);
                    cx.doc.append_child(temp, fragment)?;
                    // `table-content` is a partial selector in Defuddle (a table of contents,
                    // removed), but a real table in Gemini.
                    for el in cx.doc.query_selector_all(temp, ".table-content")? {
                        cx.doc.class_list_remove(el, &["table-content"]);
                    }
                    messages.push(Message {
                        author: "Gemini".into(),
                        content: trim(&cx.doc.inner_html(temp)).to_string(),
                        metadata: vec![("role", "assistant".into())],
                    });
                }
            }
        }
        self.message_count = Some(messages.len());
        Ok(messages)
    }

    fn get_footnotes(&self) -> &[Footnote] {
        &self.footnotes
    }

    fn get_metadata(&mut self, cx: &mut Cx) -> Result<ConversationMeta, ExtractError> {
        let title = self.get_title(cx)?;
        let count = match self.message_count {
            Some(n) => n,
            None => self.extract_messages(cx)?.len(),
        };
        Ok(ConversationMeta {
            title,
            site: "Gemini",
            description: format!("Gemini conversation with {count} messages"),
        })
    }
}

impl Extractor for GeminiExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(!self.containers.is_empty())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        extract_conversation(self, cx)
    }
}

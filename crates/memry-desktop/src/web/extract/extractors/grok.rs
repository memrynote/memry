//! `dist/extractors/grok.js`.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::trim;

use super::base::{Cx, Extracted, Extractor, text_of, trimmed};
use super::conversation::{
    Conversation, ConversationMeta, Footnote, Message, extract_conversation, page_title,
    truncated_title,
};

const CONTAINER: &str = ".relative.group.flex.flex-col.justify-center.w-full";

pub struct GrokExtractor {
    bubbles: Vec<NodeId>,
    footnotes: Vec<Footnote>,
}

impl GrokExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            bubbles: cx.qsa(CONTAINER)?,
            footnotes: Vec::new(),
        })
    }

    fn get_title(&self, cx: &mut Cx) -> Result<String, ExtractError> {
        let page = page_title(cx);
        if !page.is_empty() && page != "Grok" && !page.starts_with("Grok by ") {
            return Ok(strip_grok_suffix(&page));
        }
        if let Some(user) = cx.qs(&format!("{CONTAINER}.items-end"))?
            && let Some(bubble) = cx.doc.query_selector(user, ".message-bubble")?
        {
            return Ok(truncated_title(&trimmed(cx.doc, bubble)));
        }
        Ok("Grok Conversation".to_string())
    }

    /// `processFootnotes`: external links gain a numbered reference.
    fn process_footnotes(&mut self, content: &str) -> String {
        static LINK: LazyLock<Regex> = LazyLock::new(|| {
            // `<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)</a>`, flags `gi`.
            Regex::new(&format!(
                r#"(?i-u:<a){ws}+(?:[^>]*?{ws}+)?(?i-u:href)="([^"]*)"[^>]*>([^\n\r\x{{2028}}\x{{2029}}]*?)(?i-u:</a>)"#,
                ws = crate::web::extract::utils::js::WS
            ))
            .expect("static pattern")
        });
        let mut out = String::new();
        let mut last = 0;
        for m in LINK.captures_iter(content) {
            let whole = m.get(0).expect("group 0");
            out.push_str(&content[last..whole.start()]);
            last = whole.end();
            let url = &m[1];
            let is_http = {
                let l = url.to_ascii_lowercase();
                l.starts_with("http://") || l.starts_with("https://")
            };
            if url.is_empty() || url.starts_with('#') || !is_http {
                out.push_str(whole.as_str());
                continue;
            }
            let index = match self.footnotes.iter().position(|f| f.url == url) {
                Some(i) => i + 1,
                None => {
                    let text = match Url::parse(url) {
                        Ok(parsed) => {
                            let host = parsed.host_str().unwrap_or_default();
                            let domain = host.strip_prefix("www.").unwrap_or(host);
                            format!(
                                "<a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{domain}</a>"
                            )
                        }
                        Err(_) => format!(
                            "<a href=\"{url}\" target=\"_blank\" rel=\"noopener noreferrer\">{url}</a>"
                        ),
                    };
                    self.footnotes.push(Footnote {
                        url: url.to_string(),
                        text,
                    });
                    self.footnotes.len()
                }
            };
            out.push_str(&format!(
                "{}<sup id=\"fnref:{index}\" class=\"footnote-ref\"><a href=\"#fn:{index}\" class=\"footnote-link\">{index}</a></sup>",
                &m[2]
            ));
        }
        out.push_str(&content[last..]);
        out
    }
}

/// `title.replace(/\s-\s*Grok$/, '').trim()`.
fn strip_grok_suffix(title: &str) -> String {
    use crate::web::extract::utils::js::is_js_whitespace;
    let Some(body) = title.strip_suffix("Grok") else {
        return trim(title).to_string();
    };
    let body = body.trim_end_matches(is_js_whitespace);
    match body.strip_suffix('-') {
        Some(rest) if rest.ends_with(is_js_whitespace) => {
            trim(&rest[..rest.len() - rest.chars().next_back().map_or(0, char::len_utf8)])
                .to_string()
        }
        _ => trim(title).to_string(),
    }
}

impl Conversation for GrokExtractor {
    fn extract_messages(&mut self, cx: &mut Cx) -> Result<Vec<Message>, ExtractError> {
        let mut messages = Vec::new();
        self.footnotes.clear();
        let bubbles = self.bubbles.clone();
        for container in bubbles {
            let is_user = cx.doc.class_list_contains(container, "items-end");
            let is_grok = cx.doc.class_list_contains(container, "items-start");
            if !is_user && !is_grok {
                continue;
            }
            let Some(bubble) = cx.doc.query_selector(container, ".message-bubble")? else {
                continue;
            };
            let (role, author, content) = if is_user {
                ("user", "You", text_of(cx.doc, bubble))
            } else {
                let clone = cx.doc.clone_node(bubble, true);
                if let Some(artifact) = cx
                    .doc
                    .query_selector(clone, ".relative.border.border-border-l1.bg-surface-base")?
                {
                    cx.doc.remove(artifact);
                }
                let html = cx.doc.inner_html(clone);
                ("assistant", "Grok", self.process_footnotes(&html))
            };
            if !trim(&content).is_empty() {
                messages.push(Message {
                    author: author.to_string(),
                    content: trim(&content).to_string(),
                    metadata: vec![("role", role.to_string())],
                });
            }
        }
        Ok(messages)
    }

    fn get_footnotes(&self) -> &[Footnote] {
        &self.footnotes
    }

    fn get_metadata(&mut self, cx: &mut Cx) -> Result<ConversationMeta, ExtractError> {
        let title = self.get_title(cx)?;
        let count = self.bubbles.len();
        Ok(ConversationMeta {
            title,
            site: "Grok",
            description: format!("Grok conversation with {count} messages"),
        })
    }
}

impl Extractor for GrokExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(!self.bubbles.is_empty())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        extract_conversation(self, cx)
    }
}

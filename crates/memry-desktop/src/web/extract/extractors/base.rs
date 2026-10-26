//! `BaseExtractor` (`dist/extractors/_base.js`): the context an extractor reads and the shape
//! of what it returns.

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::fetch::Fetcher;
use crate::web::extract::utils::json::JsValue;

/// What every extractor method sees: the live page document and its document node (`this.document`),
/// the page URL and the schema.org data (`this.schemaOrgData`). The `includeReplies` option is
/// `'extractors'` for every caller, so replies are always extracted.
pub struct Cx<'a> {
    pub doc: &'a mut Document,
    pub root: NodeId,
    pub url: &'a str,
    pub schema: &'a JsValue,
}

impl Cx<'_> {
    /// `this.document.querySelector(selector)`.
    pub fn qs(&self, selector: &str) -> Result<Option<NodeId>, ExtractError> {
        self.doc.query_selector(self.root, selector)
    }

    /// `this.document.querySelectorAll(selector)` as a snapshot.
    pub fn qsa(&self, selector: &str) -> Result<Vec<NodeId>, ExtractError> {
        self.doc.query_selector_all(self.root, selector)
    }
}

/// The custom-variable-free subset of `extracted.variables` that Defuddle maps to the result.
/// An empty string stands for a falsy value: every use is `variables.x || fallback`.
#[derive(Debug, Clone, Default)]
pub struct Variables {
    pub title: String,
    pub author: String,
    pub site: String,
    pub published: String,
    pub description: String,
    pub language: String,
}

/// `ExtractorResult`.
#[derive(Debug, Clone, Default)]
pub struct Extracted {
    pub content_html: String,
    /// Run Defuddle's pipeline on this selector of the live page instead of using
    /// `content_html`.
    pub content_selector: Option<String>,
    pub variables: Variables,
}

/// One site extractor.
pub trait Extractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError>;

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError>;

    fn can_extract_async(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(false)
    }

    /// `prefersAsync()`: async extraction replaces the sync result even when that has content.
    fn prefers_async(&self) -> bool {
        false
    }

    /// `extractAsync()`: the extractors that fetch override it; the others return `extract()`.
    fn extract_async(
        &mut self,
        cx: &mut Cx,
        _fetcher: &dyn Fetcher,
    ) -> Result<Extracted, ExtractError> {
        self.extract(cx)
    }
}

/// `postTitle(author, site)`.
pub fn post_title(author: &str, site: &str) -> String {
    format!("Post by {author} on {site}")
}

/// `el.textContent ?? ''`.
pub fn text_of(doc: &Document, el: NodeId) -> String {
    doc.text_content(el).unwrap_or_default()
}

/// `el.textContent?.trim() || ''`.
pub fn trimmed(doc: &Document, el: NodeId) -> String {
    crate::web::extract::utils::js::trim(&text_of(doc, el)).to_string()
}

/// `el.getAttribute(name) || ''`.
pub fn attr_of(doc: &Document, el: NodeId, name: &str) -> String {
    doc.get_attribute(el, name)
        .map(|v| v.into_owned())
        .unwrap_or_default()
}

/// `scope.querySelector(selector)?.textContent?.trim() || ''`.
pub fn sel_text(doc: &Document, scope: NodeId, selector: &str) -> Result<String, ExtractError> {
    Ok(doc
        .query_selector(scope, selector)?
        .map(|el| trimmed(doc, el))
        .unwrap_or_default())
}

/// `scope.querySelector(selector)?.getAttribute(name) || ''`.
pub fn sel_attr(
    doc: &Document,
    scope: NodeId,
    selector: &str,
    name: &str,
) -> Result<String, ExtractError> {
    Ok(doc
        .query_selector(scope, selector)?
        .map(|el| attr_of(doc, el, name))
        .unwrap_or_default())
}

/// `text.slice(0, 140).replace(/\s+/g, ' ')`, the description cut of several extractors.
pub fn description_cut(text: &str) -> String {
    use crate::web::extract::utils::js::{WS, utf16_slice};
    use regex::Regex;
    use std::sync::LazyLock;
    static RUNS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static pattern"));
    RUNS.replace_all(&utf16_slice(text, 0, 140), " ")
        .into_owned()
}

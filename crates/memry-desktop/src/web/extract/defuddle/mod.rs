//! The `Defuddle` class of `dist/defuddle.js` (generic path), ported across the stages of Step
//! 26 (#3543).
//!
//! `parse` runs the pipeline of `parseInternal` and its retries on one document. The site
//! extractors of `dist/extractors/` are stages 5 and 6: until they land no extractor matches
//! (`findExtractor` returns nothing), and `parseAsync` reduces to `parse`. The browser-only
//! branches stay out because linkedom never takes them: it has no shadow roots
//! (`flattenShadowRoots` does nothing), no style sheets (`_evaluateMediaQueries` finds no mobile
//! styles, so `applyMobileStyles` does nothing), and no `getComputedStyle`.

pub mod boundary;
mod content;
mod images;
mod pipeline;
pub mod schema_org;
pub mod settings;
mod streamed;
mod urls;

use regex::Regex;
use std::sync::LazyLock;

use super::dom::{Document, NodeId};
use super::error::ExtractError;
use super::map::DefuddleResult;
use super::metadata::Metadata;
use super::removals::small_images::SmallImages;
use super::utils::js::utf16_len;
use super::utils::json::JsValue;
use super::utils::text::count_words;
use schema_org::{MetaTag, collect_meta_tags, extract_schema_org_data, get_schema_text};
use settings::Settings;

/// `DefuddleResponse`: the fields of the result the markdown step and `mapToArticleCapture`
/// read, plus the ones the vectors compare.
#[derive(Debug, Clone, PartialEq)]
pub struct DefuddleResponse {
    pub content: String,
    pub metadata: Metadata,
    pub schema_org_data: JsValue,
    pub word_count: usize,
}

impl DefuddleResponse {
    /// The subset `mapToArticleCapture` reads.
    pub fn to_map_input(&self) -> DefuddleResult {
        let m = &self.metadata;
        DefuddleResult {
            content: Some(self.content.clone()),
            title: Some(m.title.clone()),
            author: Some(m.author.clone()),
            published: Some(m.published.clone()),
            description: Some(m.description.clone()),
            image: Some(m.image.clone()),
            word_count: Some(self.word_count as u64),
        }
    }
}

/// One Defuddle run over a document. `root` is `this.doc`: the schema.org retry swaps it for a
/// sanitized clone and back.
pub struct Defuddle {
    pub(crate) doc: Document,
    pub(crate) root: NodeId,
    /// `options.url` (the page URL, `about:blank` when the caller has none).
    pub(crate) url: String,
    schema: Option<JsValue>,
    meta_tags: Option<Vec<MetaTag>>,
    pub(crate) metadata: Option<Metadata>,
    pub(crate) small_images: Option<SmallImages>,
}

static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new("<[^>]*>").expect("static"));
static NBSP: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i-u:&nbsp;)").expect("static"));
static AMP: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i-u:&amp;)").expect("static"));
static LT: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i-u:&lt;)").expect("static"));
static GT: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i-u:&gt;)").expect("static"));
static QUOT: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i-u:&quot;)").expect("static"));
static NUMERIC_ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new("&#[0-9]+;").expect("static"));
static NAMED_ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("&[A-Za-z0-9_]+;").expect("static"));

/// `countHtmlWords(content)`: strips tags and the common entities without parsing.
pub fn count_html_words(content: &str) -> usize {
    let text = HTML_TAG.replace_all(content, " ");
    let text = NBSP.replace_all(&text, " ");
    let text = AMP.replace_all(&text, "&");
    let text = LT.replace_all(&text, "<");
    let text = GT.replace_all(&text, ">");
    let text = QUOT.replace_all(&text, "\"");
    let text = NUMERIC_ENTITY.replace_all(&text, " ");
    let text = NAMED_ENTITY.replace_all(&text, " ");
    count_words(&text)
}

impl Defuddle {
    /// `new Defuddle(doc, { url })`.
    pub fn new(doc: Document, url: &str) -> Self {
        let root = doc.root();
        Defuddle {
            doc,
            root,
            url: url.to_string(),
            schema: None,
            meta_tags: None,
            metadata: None,
            small_images: None,
        }
    }

    /// `getSchemaOrgData()`: extracted once, before `parse` strips the scripts.
    pub(crate) fn schema_org_data(&mut self) -> Result<JsValue, ExtractError> {
        if self.schema.is_none() {
            self.schema = Some(extract_schema_org_data(&self.doc)?);
        }
        Ok(self.schema.clone().unwrap_or(JsValue::Null))
    }

    pub(crate) fn page_meta_tags(&mut self) -> Result<Vec<MetaTag>, ExtractError> {
        if self.meta_tags.is_none() {
            self.meta_tags = Some(collect_meta_tags(&self.doc)?);
        }
        Ok(self.meta_tags.clone().unwrap_or_default())
    }

    /// `parseAsync()`. No async extractor exists yet, so this is `parse()`; the `Fetcher` seam
    /// of the extractors arrives with them.
    pub fn parse_async(&mut self) -> Result<DefuddleResponse, ExtractError> {
        self.parse()
    }

    /// `parse()`: the default run and the retries for pages that yield little content.
    pub fn parse(&mut self) -> Result<DefuddleResponse, ExtractError> {
        // linkedom throws on `document.body` when the page has no element at all.
        let root = self.root;
        let Some(body) = self.doc.body_of(root) else {
            return Err(ExtractError::Dom("the document has no element".into()));
        };
        images::normalize_attributes(&mut self.doc, body)?;
        images::resolve_noscript_images(&mut self.doc, body)?;

        let settings = Settings::default();
        let mut result = self.parse_internal(settings, None)?;

        if result.word_count < 200 {
            let retry = self.parse_internal(
                Settings {
                    remove_partial_selectors: false,
                    ..settings
                },
                None,
            )?;
            // A small gain means the partial selectors rightly removed clutter.
            if retry.word_count > result.word_count * 2 {
                result = retry;
            }
        }

        if result.word_count < 50 {
            let hidden_retry = self.parse_internal(settings.keep_hidden(), None)?;
            if hidden_retry.word_count > result.word_count * 2 {
                result = hidden_retry;
            }
            if let Some(selector) = self.find_largest_hidden_content_selector()? {
                let retry = self.parse_internal(
                    Settings {
                        remove_partial_selectors: false,
                        ..settings.keep_hidden()
                    },
                    Some(&selector),
                )?;
                if retry.word_count > result.word_count
                    || (retry.word_count as f64 > 20f64.max(result.word_count as f64 * 0.7)
                        && utf16_len(&retry.content) < utf16_len(&result.content))
                {
                    result = retry;
                }
            }
        }

        if result.word_count < 50 {
            let index_retry = self.parse_internal(
                Settings {
                    remove_low_scoring: false,
                    remove_partial_selectors: false,
                    remove_content_patterns: false,
                    ..settings
                },
                None,
            )?;
            if index_retry.word_count > result.word_count {
                result = index_retry;
            }
        }

        let schema_text = get_schema_text(&result.schema_org_data, 0);
        if !schema_text.is_empty()
            && count_html_words(&schema_text) as f64 > result.word_count as f64 * 1.5
        {
            result = self.schema_text_retry(result, &schema_text)?;
        }
        Ok(result)
    }

    /// The last retry of `parse()`: the schema.org text is much longer than what was extracted,
    /// so the scorer probably picked the wrong element. Re-extracts from a sanitized clone.
    fn schema_text_retry(
        &mut self,
        mut result: DefuddleResponse,
        schema_text: &str,
    ) -> Result<DefuddleResponse, ExtractError> {
        let live = self.root;
        let safe = self.doc.clone_node(live, true);
        let safe_body = self.doc.body_of(safe);
        urls::strip_unsafe_elements(&mut self.doc, safe_body)?;
        self.root = safe;
        let outcome = (|| {
            let body = self.doc.body_of(safe);
            let best = match body {
                Some(b) => self.find_element_by_schema_text(b, schema_text)?,
                None => None,
            };
            match best {
                Some(element) => {
                    let selector = self.get_element_selector(element);
                    self.parse_internal(Settings::default(), Some(&selector))
                }
                None => {
                    result.content = schema_text.to_string();
                    result.word_count = count_html_words(schema_text);
                    Ok(result)
                }
            }
        })();
        self.root = live;
        outcome
    }
}

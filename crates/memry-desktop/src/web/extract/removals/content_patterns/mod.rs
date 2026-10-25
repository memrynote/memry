//! Port of `dist/removals/content-patterns.js`: removal of non-content blocks recognised by
//! their text and position (bylines, read times, related posts, newsletter prompts, ...).
//!
//! `patterns_a` holds the passes over the top of the content and its short metadata elements,
//! `patterns_b` the passes over its end. Every pass reads `contentText`, the text of the
//! content element taken once after the audio-widget pass, and keeps reading that snapshot
//! while the passes remove nodes, as the JS does.

mod helpers;
mod patterns_a;
mod patterns_b;
mod patterns_c;
mod regexes;

use url::Url;

use crate::web::extract::defuddle::boundary::{find_content_start, is_above_content_start};
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{Utf16Text, utf16_prefix};
use crate::web::extract::utils::text::{count_words, normalize_text};

pub use patterns_a::remove_eyebrow_label;

/// What the passes share.
pub(super) struct Page {
    pub main: NodeId,
    pub url: String,
    /// `new URL(url)`, `None` when it throws.
    pub parsed_url: Option<Url>,
    pub content_start: Option<NodeId>,
    /// `mainContent.textContent` after the audio pass.
    pub content_text: Utf16Text,
    /// `countWords(contentText)`.
    pub content_words: usize,
}

impl Page {
    /// `isPreContent(el)`.
    pub(super) fn is_pre_content(&self, doc: &Document, el: NodeId) -> bool {
        is_above_content_start(doc, el, self.content_start)
    }

    /// `contentText.indexOf(text)`.
    pub(super) fn index_of(&self, text: &str) -> i64 {
        self.content_text
            .index_of(&text.encode_utf16().collect::<Vec<_>>())
    }

    /// `contentText.indexOf(text.substring(0, 60))`.
    pub(super) fn index_of_prefix(&self, text: &str) -> i64 {
        self.content_text.index_of(&utf16_prefix(text, 60))
    }

    /// `contentText.length - (pos + text.length)`.
    pub(super) fn distance_from_end(&self, pos: i64, text: &str) -> i64 {
        self.content_text.unit_len()
            - (pos + crate::web::extract::utils::js::utf16_len(text) as i64)
    }
}

/// `removeByContentPattern(mainContent, debug, url, title, description)`.
pub fn remove_by_content_pattern(
    doc: &mut Document,
    main: NodeId,
    url: &str,
    title: &str,
    description: &str,
) -> Result<(), ExtractError> {
    // The structural anchor for "where the prose body starts".
    let content_start = find_content_start(doc, main, title)?;
    let normalized_title = normalize_text(title);
    let normalized_desc = normalize_text(description);

    let mut page = Page {
        main,
        url: url.to_string(),
        parsed_url: Url::parse(url).ok(),
        content_start,
        content_text: Utf16Text::new(""),
        content_words: 0,
    };

    patterns_a::remove_top_widgets(doc, &page)?;
    let content = helpers::text(doc, main);
    page.content_words = count_words(&content);
    page.content_text = Utf16Text::new(&content);
    patterns_a::remove_table_of_contents(doc, &page)?;
    patterns_a::remove_metadata_elements(doc, &page, &normalized_title, &normalized_desc)?;
    patterns_a::remove_boundary_time_elements(doc, &page)?;
    patterns_a::remove_metadata_lists(doc, &page)?;

    patterns_b::remove_section_breadcrumbs(doc, &page)?;
    patterns_b::remove_trailing_external_lists(doc, &page)?;
    patterns_b::remove_trailing_related_posts(doc, &page)?;
    patterns_b::remove_trailing_thin_sections(doc, &page)?;
    patterns_b::remove_boilerplate(doc, &page)?;
    patterns_b::remove_related_sections(doc, &page)?;
    patterns_b::remove_related_intros(doc, &page)?;
    patterns_b::remove_related_cards(doc, &page)?;
    patterns_c::remove_newsletters(doc, &page)?;
    patterns_c::remove_author_blocks(doc, &page)?;
    patterns_c::remove_engagement_and_tags(doc, &page)?;
    Ok(())
}

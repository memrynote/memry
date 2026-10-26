//! The removal steps of `Defuddle.parseInternal` (`dist/defuddle.js:843-905`), ported from
//! `dist/removals/*.js`. Each step edits the cloned document in place.
//!
//! `parseInternal` interleaves them with footnote and callout standardization, which later
//! stages port, so the steps run in two groups: `remove_metadata_block` before the footnotes and
//! `run_all` (or `run_step` for each `Step`) after them.

pub mod content_patterns;
pub mod hidden;
pub mod metadata_block;
pub mod scoring;
pub mod selectors;
pub mod small_images;

use crate::web::extract::defuddle::settings::Settings;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;

use small_images::SmallImages;

/// `removeMetadataBlock` when metadata found a byline, then every `<wbr>` (a word-break hint
/// that carries no content but causes whitespace during standardization).
pub fn remove_metadata_block(
    doc: &mut Document,
    main: NodeId,
    has_published_or_author: bool,
) -> Result<(), ExtractError> {
    if has_published_or_author {
        metadata_block::remove_metadata_block(doc, main)?;
    }
    for wbr in doc.query_selector_all(main, "wbr")? {
        doc.remove(wbr);
    }
    Ok(())
}

/// What the steps after the footnotes read.
pub struct Removal<'a> {
    /// The cloned document.
    pub clone: NodeId,
    /// The content element inside the clone.
    pub main: NodeId,
    pub settings: Settings,
    /// `findSmallImages` of the original document.
    pub small_images: &'a SmallImages,
    /// `this.options.url || this.doc.URL || ''`.
    pub url: &'a str,
    pub title: &'a str,
    pub description: &'a str,
}

/// One removal step, in `parseInternal` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    SmallImages,
    HiddenElements,
    EyebrowLabel,
    Selectors,
    LowScoring,
    ContentPatterns,
}

impl Step {
    pub const ALL: [Step; 6] = [
        Step::SmallImages,
        Step::HiddenElements,
        Step::EyebrowLabel,
        Step::Selectors,
        Step::LowScoring,
        Step::ContentPatterns,
    ];
}

/// Runs one step if its setting allows it.
pub fn run_step(doc: &mut Document, step: Step, r: &Removal) -> Result<(), ExtractError> {
    let s = r.settings;
    match step {
        Step::SmallImages if s.remove_small_images => {
            small_images::remove_small_images(doc, r.clone, r.small_images)
        }
        Step::HiddenElements if s.remove_hidden_elements => {
            hidden::remove_hidden_elements(doc, r.clone)
        }
        // "Eyebrow" labels hang on the first <h1>, which some sites strip by class in the
        // selector step, so this runs first.
        Step::EyebrowLabel if s.remove_content_patterns => {
            content_patterns::remove_eyebrow_label(doc, r.main)
        }
        Step::Selectors if s.remove_exact_selectors || s.remove_partial_selectors => {
            selectors::remove_by_selector(
                doc,
                r.clone,
                s.remove_exact_selectors,
                s.remove_partial_selectors,
                Some(r.main),
                !s.remove_hidden_elements,
            )
        }
        Step::LowScoring if s.remove_low_scoring => {
            scoring::score_and_remove(doc, r.clone, Some(r.main))
        }
        Step::ContentPatterns if s.remove_content_patterns => {
            content_patterns::remove_by_content_pattern(doc, r.main, r.url, r.title, r.description)
        }
        _ => Ok(()),
    }
}

/// Every step after the footnotes, in order.
pub fn run_all(doc: &mut Document, r: &Removal) -> Result<(), ExtractError> {
    for step in Step::ALL {
        run_step(doc, step, r)?;
    }
    Ok(())
}

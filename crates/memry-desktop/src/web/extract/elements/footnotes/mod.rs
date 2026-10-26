//! `dist/elements/footnotes.js`: footnotes of every markup Defuddle knows are collected, their
//! references rewritten to `sup#fnref:N > a[href="#fn:N"]`, and the notes rebuilt as
//! `div#footnotes > ol > li#fn:N.footnote`.

mod collect;
mod fallbacks;
mod items;
mod loose;
mod refs;
mod sidenotes;

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::constants::{FOOTNOTE_INLINE_REFERENCES, FOOTNOTE_LIST_SELECTORS};
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::standardize::remove_orphaned_dividers;
use crate::web::extract::utils::js::{WS, WS_BODY, trim};

/// `FOOTNOTE_SECTION_RE`: `/^(foot\s*notes?|end\s*notes?|notes?|references?)$/i`.
pub static FOOTNOTE_SECTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^(?:(?i-u:foot){WS}*(?i-u:notes?)|(?i-u:end){WS}*(?i-u:notes?)|(?i-u:notes?)|(?i-u:references?))$"
    ))
    .expect("static pattern")
});
/// `BACKREF_SYMBOLS_RE`.
pub(super) static BACKREF_SYMBOLS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^[\\^\u{21a9}\u{21a5}\u{2191}\u{21b5}\u{2934}\u{2935}\u{23ce}]+$")
        .expect("static pattern")
});
/// `FOOTNOTE_MARKER_RE`: `/^\[?\(?(\d{1,4})\)?\]?$/`.
pub(super) static FOOTNOTE_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[?\(?([0-9]{1,4})\)?\]?$").expect("static pattern"));
/// `/^\s*/` style helpers.
pub(super) static LEADING_WS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^{WS}+")).expect("static pattern"));
/// `/^[\s\^,.;]*$/`.
pub(super) static BACKREF_LEAD_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^[{WS_BODY}\\^,.;]*$")).expect("static pattern"));
/// `/^[\s,.;]*$/`.
pub(super) static BACKREF_TRAIL_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^[{WS_BODY},.;]*$")).expect("static pattern"));

/// One collected footnote: its content element, the id its references use and the reference ids
/// assigned so far.
pub(super) struct Footnote {
    pub content: NodeId,
    pub original_id: String,
    pub refs: Vec<String>,
}

/// A JS object keyed by integers: iteration is ascending numeric order.
pub(super) type Footnotes = BTreeMap<u64, Footnote>;

/// `collectFootnotes` state.
pub(super) struct State {
    pub footnotes: Footnotes,
    pub processed_ids: std::collections::HashSet<String>,
    pub count: u64,
}

impl State {
    fn new() -> Self {
        State {
            footnotes: Footnotes::new(),
            processed_ids: std::collections::HashSet::new(),
            count: 1,
        }
    }

    /// `addFootnote(state, id, content, explicitNum)`.
    pub fn add(&mut self, id: &str, content: NodeId, explicit_num: Option<u64>) -> bool {
        if id.is_empty() || self.processed_ids.contains(id) {
            return false;
        }
        let key = explicit_num.unwrap_or(self.count);
        self.footnotes.insert(
            key,
            Footnote {
                content,
                original_id: id.to_string(),
                refs: Vec::new(),
            },
        );
        self.processed_ids.insert(id.to_string());
        match explicit_num {
            None => self.count += 1,
            Some(n) if n >= self.count => self.count = n + 1,
            Some(_) => {}
        }
        true
    }
}

/// `FootnoteHandler`: the elements to remove once the notes are rebuilt.
pub(super) struct Handler {
    pub pending_removals: Vec<NodeId>,
}

/// `mergeFootnotes(target, source)`.
fn merge_footnotes(target: &mut Footnotes, source: Footnotes) {
    for (num, data) in source {
        target.entry(num).or_insert(data);
    }
}

/// `makeRefId(footnoteNumber, refsLength)`.
pub(super) fn make_ref_id(number: u64, refs_length: usize) -> String {
    if refs_length > 0 {
        format!("fnref:{number}-{}", refs_length + 1)
    } else {
        format!("fnref:{number}")
    }
}

/// `standardizeFootnotes(element)`.
pub fn standardize_footnotes(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let mut handler = Handler {
        pending_removals: Vec::new(),
    };
    handler.standardize(doc, element)
}

impl Handler {
    fn standardize(&mut self, doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
        let sidenotes = self.collect_inline_sidenotes(doc, element)?;
        let mut footnotes = self.collect_hidden_aside_footnotes(doc, element)?;
        let collected = self.collect_footnotes(doc, element)?;
        merge_footnotes(&mut footnotes, collected);
        let column = self.collect_sidenotes_column(doc, element)?;
        merge_footnotes(&mut footnotes, column);
        let aside = self.collect_aside_footnotes(doc, element)?;
        merge_footnotes(&mut footnotes, aside);

        let inline_references = doc.query_selector_all(element, &FOOTNOTE_INLINE_REFERENCES)?;
        let mut sup_groups: Vec<(NodeId, Vec<(u64, String)>)> = Vec::new();
        let mut by_original_id: HashMap<String, u64> = HashMap::new();
        for (num, data) in &footnotes {
            by_original_id.insert(data.original_id.to_lowercase(), *num);
        }

        for el in inline_references {
            if doc.parent_node(el).is_none() {
                continue;
            }
            if trim(&doc.text_content(el).unwrap_or_default()).is_empty() {
                continue;
            }
            if doc.matches(el, "cite.ltx_cite")? {
                self.expand_arxiv_citation(doc, el, &mut footnotes, &by_original_id)?;
                continue;
            }
            let mut footnote_id = String::new();
            for extractor in refs::INLINE_REF_EXTRACTORS {
                if doc.matches(el, extractor.selector)? {
                    footnote_id = (extractor.extract)(doc, el)?;
                    break;
                }
            }
            if footnote_id.is_empty()
                && let Some(href) = doc.get_attribute(el, "href").filter(|h| !h.is_empty())
            {
                footnote_id = href.strip_prefix('#').unwrap_or(&href).to_lowercase();
            }
            if footnote_id.is_empty() {
                continue;
            }
            let Some(&number) = by_original_id.get(&footnote_id.to_lowercase()) else {
                continue;
            };
            let container = refs::find_outer_footnote_container(doc, el);
            let is_sup = doc.tag_name(container).as_deref() == Some("SUP");
            // An outer sup and its inner anchor that both match keep only the first reference.
            if is_sup
                && sup_groups
                    .iter()
                    .any(|(c, group)| *c == container && group.iter().any(|(n, _)| *n == number))
            {
                continue;
            }
            let data = footnotes.get_mut(&number).unwrap_or_else(|| unreachable!());
            let ref_id = make_ref_id(number, data.refs.len());
            data.refs.push(ref_id.clone());
            if is_sup {
                match sup_groups.iter_mut().find(|(c, _)| *c == container) {
                    Some((_, group)) => group.push((number, ref_id)),
                    None => sup_groups.push((container, vec![(number, ref_id)])),
                }
            } else {
                let reference = refs::create_footnote_reference(doc, number, &ref_id)?;
                refs::replace_container_preserving_text(doc, container, reference)?;
            }
        }

        self.match_unmatched(doc, element, &mut footnotes)?;

        for (container, group) in sup_groups {
            let fragment = doc.create_document_fragment();
            for (number, ref_id) in group {
                let reference = refs::create_footnote_reference(doc, number, &ref_id)?;
                doc.append_child(fragment, reference)?;
            }
            doc.replace_with(container, &[fragment])?;
        }

        let new_list = doc.create_element("div");
        doc.set_attribute(new_list, "id", "footnotes");
        let ordered_list = doc.create_element("ol");
        let mut all = sidenotes;
        for (num, data) in footnotes {
            all.insert(num, data);
        }
        for (number, data) in &all {
            let item = self.create_footnote_item(doc, *number, data.content, &data.refs)?;
            doc.append_child(ordered_list, item)?;
        }
        for list in doc.query_selector_all(element, &FOOTNOTE_LIST_SELECTORS)? {
            doc.remove(list);
        }
        for el in std::mem::take(&mut self.pending_removals) {
            if doc.parent_node(el).is_some() {
                doc.remove(el);
            }
        }
        remove_orphaned_dividers(doc, element)?;
        if doc.child_element_count(ordered_list) > 0 {
            doc.append_child(new_list, ordered_list)?;
            doc.append_child(element, new_list)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_headings() {
        for yes in [
            "Footnotes",
            "foot note",
            "End\u{a0}Notes",
            "NOTE",
            "References",
            "reference",
        ] {
            assert!(FOOTNOTE_SECTION_RE.is_match(yes), "{yes}");
        }
        for no in ["Notes and more", "", "foot", "Footnotes\n", "Referencess"] {
            assert!(!FOOTNOTE_SECTION_RE.is_match(no), "{no}");
        }
    }
}

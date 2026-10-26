//! The fallbacks of `collectFootnotes` for pages without a recognised note list.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::elements::rule::attr_or_empty;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::{tag_lower, transfer_content};
use crate::web::extract::utils::js::{WS, parse_int, trim};
use crate::web::extract::utils::json::number_to_string;

use super::refs::href_fragment;
use super::{FOOTNOTE_MARKER, FOOTNOTE_SECTION_RE, Handler, LEADING_WS, State};

/// `/^_ftnref(\d+)$/`.
static FTNREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^_ftnref([0-9]+)$").expect("static pattern"));
/// `/^ftnt(\d+)$/`.
static FTNT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ftnt([0-9]+)$").expect("static pattern"));
/// `/^\d+[.)]*\s*$/`.
static NUMERIC_ANCHOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^[0-9]+[.)]*{WS}*$")).expect("static pattern"));
/// `/^\d+\.\s*/`.
static LEADING_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^[0-9]+\.{WS}*")).expect("static pattern"));

/// `/^h[1-6]$/`.
fn is_heading_tag(tag: &str) -> bool {
    matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

pub(super) fn text_trim(doc: &Document, el: NodeId) -> String {
    trim(&doc.text_content(el).unwrap_or_default()).to_string()
}

/// `exports.FOOTNOTE_SECTION_RE.test(el.textContent?.trim() || '')` for a heading before notes.
pub(super) fn is_notes_heading(doc: &Document, el: NodeId) -> bool {
    is_heading_tag(&tag_lower(doc, el)) && FOOTNOTE_SECTION_RE.is_match(&text_trim(doc, el))
}

/// `getChildAnchorId(el)`.
fn child_anchor_id(doc: &Document, el: NodeId) -> Result<String, ExtractError> {
    let Some(anchor) = doc.query_selector(el, "a[id], a[name]")? else {
        return Ok(String::new());
    };
    let id = doc.id_attr(anchor);
    let id = if id.is_empty() {
        attr_or_empty(doc, anchor, "name")
    } else {
        id
    };
    Ok(id.to_lowercase())
}

/// `parseFootnoteNum`'s `String(num) === numText` check: a canonical positive integer.
pub(super) fn canonical_number(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value: f64 = text.parse().ok()?;
    // Only a number whose JS string is its digits (no leading zero, below 1e21, exactly
    // representable) passes, and 0 does not.
    if value < 1.0 || number_to_string(value) != text {
        return None;
    }
    Some(value as u64)
}

pub(super) struct Numbered {
    pub num: u64,
    pub el: NodeId,
}

impl Handler {
    /// `tryDataTypeFootnotes`: O'Reilly / HTMLBook `p[data-type="footnote"]`.
    pub(super) fn try_data_type_footnotes(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        state: &mut State,
    ) -> Result<(), ExtractError> {
        for def in doc.query_selector_all(element, "p[data-type=\"footnote\"][id]")? {
            let id = doc.id_attr(def).to_lowercase();
            if id.is_empty() {
                continue;
            }
            let content = doc.create_element("div");
            let clone = doc.clone_node(def, true);
            if let Some(marker) = doc.first_element_child(clone)
                && tag_lower(doc, marker) == "sup"
                && doc.query_selector(marker, "a[href*=\"#\"]")?.is_some()
            {
                doc.remove(marker);
                self.trim_leading_whitespace(doc, clone)?;
            }
            doc.append_child(content, clone)?;
            state.add(&id, content, None);
            self.pending_removals.push(def);
        }
        Ok(())
    }

    /// `tryGenericIdDetection`: numeric anchor text that points at an in-container id.
    pub(super) fn try_generic_id_detection(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        state: &mut State,
    ) -> Result<(), ExtractError> {
        let mut candidate_refs: Vec<(String, Vec<NodeId>)> = Vec::new();
        for a in doc.query_selector_all(element, "a[href*=\"#\"]")? {
            let fragment = href_fragment(doc, Some(a));
            if fragment.is_empty() {
                continue;
            }
            if !FOOTNOTE_MARKER.is_match(&text_trim(doc, a)) {
                continue;
            }
            match candidate_refs.iter_mut().find(|(f, _)| *f == fragment) {
                Some((_, anchors)) => anchors.push(a),
                None => candidate_refs.push((fragment, vec![a])),
            }
        }
        if candidate_refs.len() < 2 {
            return Ok(());
        }
        let fragment_set: HashSet<String> = candidate_refs.iter().map(|(f, _)| f.clone()).collect();
        let mut best: Option<NodeId> = None;
        let mut best_count = 0;
        for container in doc.query_selector_all(element, "div, section, aside, footer, ol, ul")? {
            if container == element {
                continue;
            }
            let count = self
                .find_matching_footnote_elements(doc, container, &fragment_set)?
                .len();
            if count >= 2 && count >= best_count {
                best_count = count;
                best = Some(container);
            }
        }
        let Some(mut best_container) = best else {
            return Ok(());
        };
        // At least 75% of the references outside the container (not back-links) must point at
        // notes in it, so that equation cross references are not taken for footnotes.
        let ordered = self.find_matching_footnote_elements(doc, best_container, &fragment_set)?;
        let footnote_fragments: HashSet<&String> = ordered.iter().map(|(_, id)| id).collect();
        let (mut external_total, mut external_match) = (0usize, 0usize);
        for (fragment, anchors) in &candidate_refs {
            if anchors.iter().any(|&a| doc.contains(best_container, a)) {
                continue;
            }
            external_total += 1;
            if footnote_fragments.contains(fragment) {
                external_match += 1;
            }
        }
        let needed = 2.max((external_total as f64 * 0.75).ceil() as usize);
        let keep_container = external_match >= needed;
        if !keep_container {
            // JS sets `bestContainer = null`; the notes below are still collected.
            best_container = element;
        }

        for (el, id) in ordered {
            if state.processed_ids.contains(&id) {
                continue;
            }
            let content = doc.create_element("div");
            let clone = doc.clone_node(el, true);
            if let Some(id_anchor) = doc.query_selector(clone, &format!("a[id=\"{id}\"]"))? {
                let text = text_trim(doc, id_anchor);
                if text.is_empty() || NUMERIC_ANCHOR.is_match(&text) {
                    doc.remove(id_anchor);
                }
            }
            if let Some(named) = doc.query_selector(clone, "a[name]")?
                && attr_or_empty(doc, named, "name").to_lowercase() == id
            {
                doc.remove(named);
            }
            if let Some(first) = doc.child_nodes(clone).first().copied()
                && matches!(doc.node(first).kind, NodeKind::Text(_))
            {
                let text = doc.text_content(first).unwrap_or_default();
                let stripped = LEADING_NUMBER.replace(&text, "").into_owned();
                let stripped = LEADING_WS.replace(&stripped, "").into_owned();
                doc.set_text_content(first, &stripped)?;
            }
            if doc.matches(clone, "li")? {
                transfer_content(doc, clone, content)?;
            } else {
                doc.append_child(content, clone)?;
            }
            let mut sibling = doc.next_element_sibling(el);
            while let Some(s) = sibling {
                if !doc.id_attr(s).is_empty() {
                    break;
                }
                let sib_anchor = child_anchor_id(doc, s)?;
                if !sib_anchor.is_empty() && fragment_set.contains(&sib_anchor) {
                    break;
                }
                let copy = doc.clone_node(s, true);
                doc.append_child(content, copy)?;
                sibling = doc.next_element_sibling(s);
            }
            state.add(&id, content, None);
        }
        if keep_container {
            self.pending_removals.push(best_container);
        }
        Ok(())
    }

    /// `findMatchingFootnoteElements(container, fragmentSet)`.
    fn find_matching_footnote_elements(
        &self,
        doc: &Document,
        container: NodeId,
        fragments: &HashSet<String>,
    ) -> Result<Vec<(NodeId, String)>, ExtractError> {
        let mut results = Vec::new();
        let mut seen = HashSet::new();
        for el in doc.query_selector_all(container, "li, p, div")? {
            let own = doc.id_attr(el);
            let mut id = String::new();
            if !own.is_empty() && fragments.contains(&own.to_lowercase()) {
                id = own.to_lowercase();
            } else if own.is_empty() {
                let anchor = child_anchor_id(doc, el)?;
                if !anchor.is_empty() && fragments.contains(&anchor) {
                    id = anchor;
                }
            }
            if !id.is_empty() && seen.insert(id.clone()) {
                results.push((el, id));
            }
        }
        Ok(results)
    }

    /// `tryWordExport`: `href="#_ftnN"` references and `_ftnrefN` back-links.
    pub(super) fn try_word_export(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        state: &mut State,
    ) -> Result<(), ExtractError> {
        let backrefs = doc.query_selector_all(element, "a[href*=\"#_ftnref\"]")?;
        if backrefs.len() < 2 {
            return Ok(());
        }
        let mut pairs = Vec::new();
        for anchor in backrefs {
            if let Some(m) = FTNREF.captures(&href_fragment(doc, Some(anchor))) {
                pairs.push((parse_int(&m[1]).unwrap_or(0) as u64, anchor));
            }
        }
        pairs.sort_by_key(|(num, _)| *num);
        for (num, anchor) in pairs {
            let original_id = format!("_ftn{num}");
            if state.processed_ids.contains(&original_id) {
                continue;
            }
            let mut container = doc.parent_element(anchor);
            while let Some(c) = container {
                if c == element {
                    break;
                }
                if matches!(tag_lower(doc, c).as_str(), "p" | "div" | "li") {
                    break;
                }
                container = doc.parent_element(c);
            }
            let Some(container) = container.filter(|&c| c != element) else {
                continue;
            };
            let clone = doc.clone_node(container, true);
            if let Some(backref) = doc.query_selector(clone, "a[href*=\"_ftnref\"]")? {
                match doc.closest(backref, "sup")? {
                    Some(sup) => doc.remove(sup),
                    None => doc.remove(backref),
                }
            }
            let content = doc.create_element("div");
            doc.append_child(content, clone)?;
            state.add(&original_id, content, Some(num));
            self.pending_removals.push(container);
        }
        Ok(())
    }

    /// `tryGoogleDocs`: `p[id^="ftnt"]` with a `#ftnt_ref` back-link.
    pub(super) fn try_google_docs(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        state: &mut State,
    ) -> Result<(), ExtractError> {
        let mut pairs = Vec::new();
        for p in doc.query_selector_all(element, "p[id^=\"ftnt\"]")? {
            if let Some(m) = FTNT.captures(&doc.id_attr(p)) {
                pairs.push(Numbered {
                    num: parse_int(&m[1]).unwrap_or(0) as u64,
                    el: p,
                });
            }
        }
        if pairs.len() < 2 {
            return Ok(());
        }
        pairs.sort_by_key(|p| p.num);
        for Numbered { num, el } in &pairs {
            let original_id = format!("ftnt{num}");
            if state.processed_ids.contains(&original_id) {
                continue;
            }
            let clone = doc.clone_node(*el, true);
            if let Some(back) = doc.query_selector(clone, "a[href*=\"#ftnt_ref\"]")? {
                doc.remove(back);
            }
            let content = doc.create_element("div");
            doc.append_child(content, clone)?;
            state.add(&original_id, content, Some(*num));
            self.pending_removals.push(*el);
            if let Some(parent) = doc.parent_element(*el)
                && parent != element
                && tag_lower(doc, parent) == "div"
                && doc.child_element_count(parent) == 1
            {
                self.pending_removals.push(parent);
            }
        }
        // The "Footnotes" heading before the first note goes too.
        let first = pairs[0].el;
        let scan_from = match doc.parent_element(first) {
            Some(p) if p != element && tag_lower(doc, p) == "div" => p,
            _ => first,
        };
        if let Some(prev) = doc.previous_element_sibling(scan_from)
            && is_notes_heading(doc, prev)
        {
            self.pending_removals.push(prev);
        }
        Ok(())
    }
}

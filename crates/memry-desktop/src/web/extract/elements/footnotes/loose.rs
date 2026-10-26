//! The loose-note fallbacks of `collectFootnotes`: numbered paragraphs, `p.footnote` and labeled
//! sections.

use std::collections::HashSet;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::tag_lower;

use super::fallbacks::{Numbered, canonical_number, is_notes_heading, text_trim};
use super::{FOOTNOTE_SECTION_RE, Handler, LEADING_WS, State};

impl Handler {
    /// `trimLeadingWhitespace(parent)`: the first text node loses its leading whitespace.
    pub(super) fn trim_leading_whitespace(
        &self,
        doc: &mut Document,
        parent: NodeId,
    ) -> Result<(), ExtractError> {
        if let Some(first) = doc.first_child(parent)
            && matches!(doc.node(first).kind, NodeKind::Text(_))
        {
            let text = doc.text_content(first).unwrap_or_default();
            doc.set_text_content(first, &LEADING_WS.replace(&text, ""))?;
        }
        Ok(())
    }

    /// `isBoldWrappedSup(el)`.
    pub(super) fn is_bold_wrapped_sup(&self, doc: &Document, el: NodeId) -> bool {
        let tag = tag_lower(doc, el);
        (tag == "b" || tag == "strong")
            && doc.first_child(el) == doc.first_element_child(el)
            && doc
                .first_element_child(el)
                .is_some_and(|c| tag_lower(doc, c) == "sup")
    }

    /// `stripMarkerAndWrap(el)`.
    pub(super) fn strip_marker_and_wrap(
        &self,
        doc: &mut Document,
        el: NodeId,
    ) -> Result<NodeId, ExtractError> {
        let content = doc.create_element("div");
        let clone = doc.clone_node(el, true);
        if let Some(marker) = doc.first_element_child(clone) {
            if self.is_bold_wrapped_sup(doc, marker) {
                if let Some(inner) = doc.first_element_child(marker) {
                    doc.remove(inner);
                }
                self.trim_leading_whitespace(doc, marker)?;
            } else {
                doc.remove(marker);
                self.trim_leading_whitespace(doc, clone)?;
            }
        }
        doc.append_child(content, clone)?;
        Ok(content)
    }

    /// `parseFootnoteNum(el)`.
    pub(super) fn parse_footnote_num(&self, doc: &Document, el: NodeId) -> Option<u64> {
        doc.first_child(el)?;
        let mut first = doc.first_element_child(el)?;
        if Some(first) != doc.first_child(el) {
            return None;
        }
        let mut tag = tag_lower(doc, first);
        if self.is_bold_wrapped_sup(doc, first) {
            first = doc.first_element_child(first)?;
            tag = "sup".to_string();
        }
        if tag != "sup" && tag != "strong" {
            return None;
        }
        canonical_number(&text_trim(doc, first))
    }

    /// `crossValidate(element, paragraphs)`: at least two `<sup>` markers in the text match.
    pub(super) fn cross_validate(
        &self,
        doc: &Document,
        element: NodeId,
        paragraphs: &[Numbered],
    ) -> Result<bool, ExtractError> {
        let numbered: HashSet<u64> = paragraphs.iter().map(|p| p.num).collect();
        let mut matched = HashSet::new();
        for sup in doc.query_selector_all(element, "sup")? {
            if paragraphs.iter().any(|p| doc.contains(p.el, sup)) {
                continue;
            }
            if doc.query_selector(sup, "a")?.is_some() {
                continue;
            }
            let text = text_trim(doc, sup);
            if let Some(n) = canonical_number(&text)
                && numbered.contains(&n)
            {
                matched.insert(n);
            }
        }
        Ok(matched.len() >= 2)
    }

    /// `tryLabeledSection`: a container named "footnote" whose first heading says so.
    pub(super) fn try_labeled_section(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        state: &mut State,
    ) -> Result<(), ExtractError> {
        for container in doc.query_selector_all(element, "div, section, aside")? {
            let class = doc.class_name(container).to_ascii_lowercase();
            let id = doc.id_attr(container).to_ascii_lowercase();
            if !class.contains("footnote") && !id.contains("footnote") {
                continue;
            }
            let Some(heading) = doc.query_selector(container, "h1, h2, h3, h4, h5, h6")? else {
                continue;
            };
            if !FOOTNOTE_SECTION_RE.is_match(&text_trim(doc, heading)) {
                continue;
            }
            let mut paragraphs = Vec::new();
            for p in doc.query_selector_all(container, "p")? {
                if let Some(num) = self.parse_footnote_num(doc, p) {
                    paragraphs.push(Numbered { num, el: p });
                }
            }
            if paragraphs.is_empty() {
                continue;
            }
            let numbered: HashSet<NodeId> = paragraphs.iter().map(|p| p.el).collect();
            for Numbered { num, el } in &paragraphs {
                let content = self.strip_marker_and_wrap(doc, *el)?;
                let mut sibling = doc.next_element_sibling(*el);
                while let Some(s) = sibling {
                    if numbered.contains(&s) {
                        break;
                    }
                    if !text_trim(doc, s).is_empty() {
                        let copy = doc.clone_node(s, true);
                        doc.append_child(content, copy)?;
                    }
                    self.pending_removals.push(s);
                    sibling = doc.next_element_sibling(s);
                }
                state.add(&num.to_string(), content, None);
                self.pending_removals.push(*el);
            }
            self.pending_removals.push(container);
            break;
        }
        Ok(())
    }

    /// `tryLooseFootnotes`.
    pub(super) fn try_loose_footnotes(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        state: &mut State,
    ) -> Result<(), ExtractError> {
        let Some((paragraphs, to_remove)) = self.find_loose_footnote_paragraphs(doc, element)?
        else {
            return Ok(());
        };
        let remove_set: HashSet<NodeId> = to_remove.iter().copied().collect();
        for i in 0..paragraphs.len() {
            let Numbered { num, el } = &paragraphs[i];
            let next_def = paragraphs.get(i + 1).map(|p| p.el);
            let content = self.strip_marker_and_wrap(doc, *el)?;
            let mut sibling = doc.next_element_sibling(*el);
            while let Some(s) = sibling {
                if Some(s) == next_def || !remove_set.contains(&s) {
                    break;
                }
                let copy = doc.clone_node(s, true);
                doc.append_child(content, copy)?;
                sibling = doc.next_element_sibling(s);
            }
            state.add(&num.to_string(), content, None);
        }
        self.pending_removals.extend(to_remove);
        Ok(())
    }

    /// `tryClassFootnote`: `<p class="footnote"><sup>N</sup>content</p>`.
    pub(super) fn try_class_footnote(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        state: &mut State,
    ) -> Result<(), ExtractError> {
        let mut paragraphs = Vec::new();
        for p in doc.query_selector_all(element, "p.footnote")? {
            if let Some(num) = self.parse_footnote_num(doc, p) {
                paragraphs.push(Numbered { num, el: p });
            }
        }
        for Numbered { num, el } in &paragraphs {
            let content = self.strip_marker_and_wrap(doc, *el)?;
            state.add(&num.to_string(), content, None);
        }
        self.pending_removals
            .extend(paragraphs.iter().map(|p| p.el));
        Ok(())
    }

    /// `findLooseFootnoteParagraphs(element)`: the numbered paragraphs and what to remove.
    #[allow(clippy::type_complexity)]
    fn find_loose_footnote_paragraphs(
        &self,
        doc: &Document,
        element: NodeId,
    ) -> Result<Option<(Vec<Numbered>, Vec<NodeId>)>, ExtractError> {
        let all_ps = doc.query_selector_all(element, "p")?;
        let container = match all_ps.last() {
            Some(&last) => doc.parent_element(last).unwrap_or(element),
            None => element,
        };
        let children = doc.children(container);

        // Strategy 1: after the last <hr>.
        for i in (0..children.len()).rev() {
            if tag_lower(doc, children[i]) != "hr" {
                continue;
            }
            let mut paragraphs = Vec::new();
            for &child in &children[i + 1..] {
                if let Some(num) = self.parse_footnote_num(doc, child) {
                    paragraphs.push(Numbered { num, el: child });
                }
            }
            if paragraphs.len() >= 2 && self.cross_validate(doc, element, &paragraphs)? {
                return Ok(Some((paragraphs, children[i..].to_vec())));
            }
            break;
        }

        // Strategy 2: trailing numbered paragraphs.
        let mut trailing: Vec<Numbered> = Vec::new();
        let mut first_idx = 0;
        for i in (0..children.len()).rev() {
            let child = children[i];
            let tag = tag_lower(doc, child);
            if tag == "p" {
                if let Some(num) = self.parse_footnote_num(doc, child) {
                    trailing.insert(0, Numbered { num, el: child });
                    first_idx = i;
                    continue;
                }
                break;
            }
            if matches!(tag.as_str(), "ul" | "ol" | "blockquote") {
                continue;
            }
            break;
        }
        if trailing.len() >= 2 && self.cross_validate(doc, element, &trailing)? {
            let mut to_remove = children[first_idx..].to_vec();
            if let Some(prev) = doc.previous_element_sibling(trailing[0].el)
                && is_notes_heading(doc, prev)
            {
                to_remove.insert(0, prev);
            }
            return Ok(Some((trailing, to_remove)));
        }

        // Strategy 3: numbered paragraphs in the second half of the document.
        let half = all_ps.len() / 2;
        let mut scattered = Vec::new();
        for &p in &all_ps[half..] {
            if let Some(num) = self.parse_footnote_num(doc, p) {
                scattered.push(Numbered { num, el: p });
            }
        }
        if scattered.len() >= 2 && self.cross_validate(doc, element, &scattered)? {
            let to_remove = scattered.iter().map(|p| p.el).collect();
            return Ok(Some((scattered, to_remove)));
        }
        Ok(None)
    }
}

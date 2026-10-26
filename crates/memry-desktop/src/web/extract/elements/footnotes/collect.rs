//! `collectFootnotes(element)`: the note lists of each markup, then the fallbacks that look for
//! notes without a list.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::constants::FOOTNOTE_LIST_SELECTORS;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::rule::attr_or_empty;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, trim};

use super::{Footnotes, Handler, State};

/// `/^footnote-(\d+)$/`.
static FOOTNOTE_DIV_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^footnote-([0-9]+)$").expect("static pattern"));
/// `/^\s*\.\s*/`.
static LEADING_DOT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^{WS}*\.{WS}*")).expect("static pattern"));
/// `/\.$/`.
fn strip_trailing_dot(s: &str) -> &str {
    s.strip_suffix('.').unwrap_or(s)
}

impl Handler {
    /// `collectFootnotes(element)`.
    pub(super) fn collect_footnotes(
        &mut self,
        doc: &mut Document,
        element: NodeId,
    ) -> Result<Footnotes, ExtractError> {
        let mut state = State::new();
        for list in doc.query_selector_all(element, &FOOTNOTE_LIST_SELECTORS)? {
            self.collect_list(doc, element, list, &mut state)?;
        }
        for fallback in 0..7 {
            if state.count > 1 {
                break;
            }
            match fallback {
                0 => self.try_data_type_footnotes(doc, element, &mut state)?,
                1 => self.try_generic_id_detection(doc, element, &mut state)?,
                2 => self.try_word_export(doc, element, &mut state)?,
                3 => self.try_google_docs(doc, element, &mut state)?,
                4 => self.try_labeled_section(doc, element, &mut state)?,
                5 => self.try_loose_footnotes(doc, element, &mut state)?,
                _ => self.try_class_footnote(doc, element, &mut state)?,
            }
        }
        Ok(state.footnotes)
    }

    fn collect_list(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        list: NodeId,
        state: &mut State,
    ) -> Result<(), ExtractError> {
        // Wikidot: div.footnotes-footer holds div.footnote-footer children.
        if doc.matches(list, "div.footnotes-footer")? {
            for div in doc.query_selector_all(list, "div.footnote-footer")? {
                let div_id = doc.id_attr(div);
                let Some(m) = FOOTNOTE_DIV_ID.captures(&div_id) else {
                    continue;
                };
                let id = m[1].to_string();
                if state.processed_ids.contains(&id) {
                    continue;
                }
                let clone = doc.clone_node(div, true);
                if let Some(back) = doc.query_selector(clone, "a")? {
                    doc.remove(back);
                }
                let html = doc.inner_html(clone);
                let text = LEADING_DOT.replace(&html, "").into_owned();
                let content = doc.create_element("div");
                let fragment = doc.parse_fragment(trim(&text));
                doc.append_child(content, fragment)?;
                state.add(&id, content, None);
            }
            return Ok(());
        }
        // pulldown-cmark / mdBook / zola: a standalone div.footnote-definition.
        if doc.matches(list, "div.footnote-definition")? {
            let wrapped = match doc.parent_element(list) {
                Some(parent) => doc.matches(parent, "div.footnote-definitions")?,
                None => false,
            };
            if !wrapped {
                let id = doc.id_attr(list).to_lowercase();
                let clone = doc.clone_node(list, true);
                if let Some(label) = doc.query_selector(clone, "sup.footnote-definition-label")? {
                    doc.remove(label);
                }
                state.add(&id, clone, None);
                return Ok(());
            }
        }
        // Hugo / org-mode: div.footnote-definitions with div.footnote-definition children.
        if doc.matches(list, "div.footnote-definitions")? {
            for def in doc.query_selector_all(list, "div.footnote-definition")? {
                let sup = doc.query_selector(def, "sup[id]")?;
                let body = doc.query_selector(def, ".footnote-body")?;
                let (Some(sup), Some(body)) = (sup, body) else {
                    continue;
                };
                let copy = doc.clone_node(body, true);
                state.add(&doc.id_attr(sup).to_lowercase(), copy, None);
            }
            if let Some(parent) = doc.parent_element(list)
                && parent != element
                && doc.class_list_contains(parent, "footnotes")
            {
                self.pending_removals.push(parent);
            }
            return Ok(());
        }
        // Easy Footnotes WP plugin: the id is on a child span.
        if doc.matches(list, "ol.easy-footnotes-wrapper")? {
            for li in doc.query_selector_all(list, "li.easy-footnote-single")? {
                let Some(id_span) =
                    doc.query_selector(li, "span[id^=\"easy-footnote-bottom-\"]")?
                else {
                    continue;
                };
                let clone = doc.clone_node(li, true);
                if let Some(s) = doc.query_selector(clone, "span[id^=\"easy-footnote-bottom-\"]")? {
                    doc.remove(s);
                }
                if let Some(a) = doc.query_selector(clone, "a.easy-footnote-to-top")? {
                    doc.remove(a);
                }
                state.add(&doc.id_attr(id_span).to_lowercase(), clone, None);
            }
            for span in doc.query_selector_all(element, "span.easy-footnote-margin-adjust")? {
                self.pending_removals.push(span);
            }
            return Ok(());
        }
        // GNU Texinfo: a heading per footnote followed by its body.
        if doc.matches(list, "div.footnotes-segment")? {
            for heading in doc.query_selector_all(list, "h5.footnote-body-heading")? {
                let id = match doc.query_selector(heading, "a[id]")? {
                    Some(a) => doc.id_attr(a).to_lowercase(),
                    None => String::new(),
                };
                if id.is_empty() {
                    continue;
                }
                let content = doc.create_element("div");
                let mut sibling = doc.next_element_sibling(heading);
                while let Some(s) = sibling {
                    if doc.tag_name(s).as_deref() == Some("H5")
                        && doc.class_list_contains(s, "footnote-body-heading")
                    {
                        break;
                    }
                    if !trim(&doc.text_content(s).unwrap_or_default()).is_empty()
                        || doc.query_selector(s, "img, br")?.is_some()
                    {
                        let copy = doc.clone_node(s, true);
                        doc.append_child(content, copy)?;
                    }
                    sibling = doc.next_element_sibling(s);
                }
                state.add(&id, content, None);
            }
            self.pending_removals.push(list);
            return Ok(());
        }
        // Substack: individual footnote divs with no parent list.
        if doc.matches(list, "div.footnote[data-component-name=\"FootnoteToDOM\"]")? {
            let anchor = doc.query_selector(list, "a.footnote-number")?;
            let content = doc.query_selector(list, ".footnote-content")?;
            if let (Some(anchor), Some(content)) = (anchor, content) {
                let id = doc
                    .id_attr(anchor)
                    .replacen("footnote-", "", 1)
                    .to_lowercase();
                state.add(&id, content, None);
            }
            return Ok(());
        }
        for li in doc.query_selector_all(list, "li, div[role=\"listitem\"]")? {
            let (id, content) = self.extract_list_item_id_and_content(doc, li)?;
            state.add(&id, content.unwrap_or(li), None);
        }
        Ok(())
    }

    /// `extractListItemIdAndContent(li)`: Science `.citations`, arXiv `bib.bib*`, `fn:*`, `fn*`,
    /// Nature `data-counter` and MediaWiki `cite_note`.
    fn extract_list_item_id_and_content(
        &self,
        doc: &Document,
        li: NodeId,
    ) -> Result<(String, Option<NodeId>), ExtractError> {
        static CITE_NOTE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"cite_note-([^\n\r\x{2028}\x{2029}]+)").expect("static pattern")
        });
        if let Some(citations) = doc.query_selector(li, ".citations")? {
            let id = doc.id_attr(citations).to_lowercase();
            if id.starts_with('r') {
                return Ok((id, doc.query_selector(citations, ".citation-content")?));
            }
        }
        let raw_id = doc.id_attr(li).to_lowercase();
        // Order matters: `fn:` must precede `fn`, else `fn:3` would strip to `:3`.
        for prefix in ["bib.bib", "fn:", "fn"] {
            if let Some(rest) = raw_id.strip_prefix(prefix) {
                return Ok((rest.to_string(), Some(li)));
            }
        }
        if doc.has_attribute(li, "data-counter") {
            let counter = attr_or_empty(doc, li, "data-counter");
            return Ok((strip_trailing_dot(&counter).to_lowercase(), Some(li)));
        }
        let last = raw_id.rsplit('/').next().unwrap_or("");
        let id = match CITE_NOTE.captures(last) {
            Some(m) => m[1].to_string(),
            None => raw_id.clone(),
        };
        Ok((id, Some(li)))
    }
}

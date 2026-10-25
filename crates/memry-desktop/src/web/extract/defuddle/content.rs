//! Finding the content element (`findMainContent` and its helpers, `dist/defuddle.js:979-1170`),
//! the schema.org text lookup and the selector Defuddle builds for a retry.

use crate::web::extract::constants::{
    BLOCK_ELEMENTS_SELECTOR, ENTRY_POINT_ELEMENTS, HIDDEN_EXACT_SKIP_SELECTOR,
};
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::removals::scoring::{find_best_element, score_element};
use crate::web::extract::utils::dom::tag_lower;
use crate::web::extract::utils::js::{
    is_js_whitespace, parse_int, split_whitespace_runs, trim, utf16_slice,
};
use crate::web::extract::utils::text::count_words;

use super::Defuddle;

/// `UNSAFE_CSS_CLASS_RE`: characters that make a class name invalid in a selector (Tailwind
/// utilities such as `sm:pt-[131px]`).
fn unsafe_css_class(class: &str) -> bool {
    class.chars().any(|c| ":[]()#>~+,".contains(c))
}

struct Candidate {
    element: NodeId,
    score: f64,
    selector_index: usize,
}

fn words_of(doc: &Document, el: NodeId) -> usize {
    count_words(&doc.text_content(el).unwrap_or_default())
}

impl Defuddle {
    /// `findMainContent(doc)` on the cloned document `root`.
    pub(crate) fn find_main_content(
        &mut self,
        root: NodeId,
    ) -> Result<Option<NodeId>, ExtractError> {
        let doc = &self.doc;
        let mut candidates: Vec<Candidate> = Vec::new();
        for (index, selector) in ENTRY_POINT_ELEMENTS.iter().enumerate() {
            for element in doc.query_selector_all(root, selector)? {
                // Earlier selectors rank higher, then the content analysis adds its score.
                let base = ((ENTRY_POINT_ELEMENTS.len() - index) * 40) as f64;
                candidates.push(Candidate {
                    element,
                    score: base + score_element(doc, element)?,
                    selector_index: index,
                });
            }
        }
        if candidates.is_empty() {
            return self.find_content_by_scoring(root);
        }
        // `sort` is stable, so equal scores keep document order.
        candidates.sort_by(|a, b| b.score.total_cmp(&a.score));

        if candidates.len() == 1
            && tag_lower(&self.doc, candidates[0].element) == "body"
            && let Some(table) = self.find_table_based_content(root)?
        {
            return Ok(Some(table));
        }

        // A child candidate that matched a higher-priority selector beats its parent when it
        // has real content, unless the parent holds several of them (a listing page).
        let doc = &self.doc;
        let top = &candidates[0];
        let mut best = top;
        for child in &candidates[1..] {
            if child.selector_index < best.selector_index
                && doc.contains(best.element, child.element)
                && words_of(doc, child.element) > 50
            {
                let mut siblings = 0;
                for c in &candidates {
                    if c.selector_index == child.selector_index
                        && doc.contains(top.element, c.element)
                    {
                        siblings += 1;
                        if siblings > 1 {
                            break;
                        }
                    }
                }
                if siblings > 1 {
                    continue;
                }
                best = child;
            }
        }
        Ok(Some(best.element))
    }

    /// `findTableBasedContent(doc)`: old table layouts. `getComputedStyle` is unavailable in
    /// linkedom, so only the attribute hints count.
    fn find_table_based_content(&mut self, root: NodeId) -> Result<Option<NodeId>, ExtractError> {
        let doc = &self.doc;
        let mut has_table_layout = false;
        for table in doc.get_elements_by_tag_name(root, "table") {
            let width = parse_int(&doc.get_attribute(table, "width").unwrap_or_default());
            let class = doc.class_name(table).to_lowercase();
            let multi_column = doc
                .get_elements_by_tag_name(table, "tr")
                .into_iter()
                .any(|row| {
                    let cells: Vec<NodeId> = doc
                        .children(row)
                        .into_iter()
                        .filter(|&c| doc.tag_name(c).as_deref() == Some("TD"))
                        .collect();
                    cells.len() >= 2
                        && cells
                            .iter()
                            .any(|&c| doc.get_attribute(c, "width").is_some_and(|w| !w.is_empty()))
                });
            if width.is_some_and(|w| w > 400)
                || doc.get_attribute(table, "align").as_deref() == Some("center")
                || class.contains("content")
                || class.contains("article")
                || multi_column
            {
                has_table_layout = true;
                break;
            }
        }
        if !has_table_layout {
            return Ok(None);
        }
        let cells = doc.get_elements_by_tag_name(root, "td");
        let Some(best_cell) = find_best_element(doc, &cells, 50.0)? else {
            return Ok(None);
        };
        // More text outside the best cell than inside means the tables are peripheral.
        let best_words = words_of(doc, best_cell);
        let body_words = match self.doc.body_of(root) {
            Some(body) => words_of(&self.doc, body),
            None => words_of(
                &self.doc,
                self.doc.document_element_of(root).unwrap_or(root),
            ),
        };
        if best_words * 2 < body_words {
            return Ok(None);
        }
        Ok(Some(best_cell))
    }

    /// `findContentByScoring(doc)`: the block element with the highest positive score.
    fn find_content_by_scoring(&self, root: NodeId) -> Result<Option<NodeId>, ExtractError> {
        let mut best: Option<(f64, NodeId)> = None;
        for element in self
            .doc
            .query_selector_all(root, &BLOCK_ELEMENTS_SELECTOR)?
        {
            let score = score_element(&self.doc, element)?;
            if score > 0.0 && best.is_none_or(|(s, _)| score > s) {
                best = Some((score, element));
            }
        }
        Ok(best.map(|(_, e)| e))
    }

    /// `getElementSelector(element)`: tag, id or safe classes of each ancestor, joined by `>`.
    pub(crate) fn get_element_selector(&self, element: NodeId) -> String {
        let doc = &self.doc;
        let document_element = doc.document_element_of(self.root);
        let mut parts: Vec<String> = Vec::new();
        let mut current = Some(element);
        while let Some(c) = current {
            if Some(c) == document_element {
                break;
            }
            let mut selector = tag_lower(doc, c);
            let id = doc.id_attr(c);
            let class = doc.class_name(c);
            if !id.is_empty() {
                selector.push('#');
                selector.push_str(&id);
            } else if !class.is_empty() {
                let safe: Vec<&str> = split_whitespace_runs(trim(&class))
                    .into_iter()
                    .filter(|cls| !unsafe_css_class(cls))
                    .collect();
                if !safe.is_empty() {
                    selector.push('.');
                    selector.push_str(&safe.join("."));
                }
            }
            parts.push(selector);
            current = doc.parent_element(c);
        }
        parts.reverse();
        parts.join(" > ")
    }

    /// `findLargestHiddenContentSelector()`: the hidden subtree with the most words (30 at least).
    pub(crate) fn find_largest_hidden_content_selector(
        &mut self,
    ) -> Result<Option<String>, ExtractError> {
        let root = self.root;
        let Some(body) = self.doc.body_of(root) else {
            return Ok(None);
        };
        let doc = &self.doc;
        let mut best: Option<NodeId> = None;
        let mut best_words = 0;
        for el in doc.query_selector_all(body, &HIDDEN_EXACT_SKIP_SELECTOR)? {
            if doc.class_name(el).contains("math") {
                continue;
            }
            let words = words_of(doc, el);
            if words > best_words {
                best = Some(el);
                best_words = words;
            }
        }
        Ok(match best {
            Some(el) if best_words >= 30 => Some(self.get_element_selector(el)),
            _ => None,
        })
    }

    /// `_findElementBySchemaText(root, schemaText)`: the smallest element that holds the first
    /// paragraph of the schema.org text and at least 80% of its words.
    pub(crate) fn find_element_by_schema_text(
        &self,
        root: NodeId,
        schema_text: &str,
    ) -> Result<Option<NodeId>, ExtractError> {
        let first = trim(first_paragraph(schema_text));
        let phrase = trim(&utf16_slice(first, 0, 100)).to_string();
        if phrase.is_empty() {
            return Ok(None);
        }
        let schema_words = count_words(schema_text) as f64;
        let mut best = None;
        let mut best_size = usize::MAX;
        for el in self.doc.query_selector_all(root, "*")? {
            if el == root {
                continue;
            }
            let text = self.doc.text_content(el).unwrap_or_default();
            if !text.contains(&phrase) {
                continue;
            }
            let words = count_words(&text);
            if words as f64 >= schema_words * 0.8 && words < best_size {
                best_size = words;
                best = Some(el);
            }
        }
        Ok(best)
    }
}

/// `text.split(/\n\s*\n/)[0]`: up to the first line feed whose following whitespace run holds
/// another line feed.
fn first_paragraph(text: &str) -> &str {
    for (i, c) in text.char_indices() {
        if c != '\n' {
            continue;
        }
        let rest = &text[i + 1..];
        let run = rest.len() - rest.trim_start_matches(is_js_whitespace).len();
        if rest[..run].contains('\n') {
            return &text[..i];
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_paragraph_splits_on_blank_lines() {
        assert_eq!(first_paragraph("a\nb\n\nc"), "a\nb");
        assert_eq!(first_paragraph("a\n \t\nb"), "a");
        assert_eq!(first_paragraph("a\n\n\nb"), "a");
        assert_eq!(first_paragraph("no break\nhere"), "no break\nhere");
        assert_eq!(first_paragraph("\n\nx"), "");
    }

    #[test]
    fn unsafe_classes() {
        assert!(unsafe_css_class("sm:pt-[131px]"));
        assert!(!unsafe_css_class("plain-class_1"));
    }
}

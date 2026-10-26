//! Sidenotes and notes kept outside a list: Tufte and Org Mode sidenotes, sidenote columns,
//! `aside > ol[start]` and hidden asides linked by `data-definition`.

use std::collections::HashMap;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::elements::rule::{attr, attr_or_empty};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::transfer_content;
use crate::web::extract::utils::js::parse_int;

use super::refs::create_footnote_reference;
use super::{Footnote, Footnotes, Handler};

impl Handler {
    /// `collectInlineSidenotes(element)`.
    pub(super) fn collect_inline_sidenotes(
        &mut self,
        doc: &mut Document,
        element: NodeId,
    ) -> Result<Footnotes, ExtractError> {
        let mut footnotes = Footnotes::new();
        let containers = doc.query_selector_all(
            element,
            "span.footnote-container, span.sidenote-container, span.inline-footnote",
        )?;
        if containers.is_empty() {
            let footrefs = doc.query_selector_all(element, "label.footref")?;
            if !footrefs.is_empty() {
                let mut count: u64 = 1;
                for label in footrefs {
                    let toggle = |doc: &Document, el: Option<NodeId>| {
                        el.is_some_and(|e| {
                            doc.tag_name(e).as_deref() == Some("INPUT")
                                && doc.class_list_contains(e, "footref-toggle")
                        })
                    };
                    let mut sibling = doc.next_element_sibling(label);
                    if toggle(doc, sibling) {
                        sibling = sibling.and_then(|s| doc.next_element_sibling(s));
                    }
                    let Some(sibling) = sibling.filter(|&s| {
                        doc.tag_name(s).as_deref() == Some("SPAN")
                            && doc.class_list_contains(s, "sidenote")
                    }) else {
                        continue;
                    };
                    let content = doc.clone_node(sibling, true);
                    if let Some(leading) = doc.query_selector(content, "sup")?
                        && doc.first_child(content) == Some(leading)
                    {
                        doc.remove(leading);
                    }
                    footnotes.insert(
                        count,
                        Footnote {
                            content,
                            original_id: count.to_string(),
                            refs: vec![format!("fnref:{count}")],
                        },
                    );
                    let reference =
                        create_footnote_reference(doc, count, &format!("fnref:{count}"))?;
                    let input = doc.next_element_sibling(label);
                    if toggle(doc, input)
                        && let Some(input) = input
                    {
                        doc.remove(input);
                    }
                    doc.remove(sibling);
                    doc.replace_with(label, &[reference])?;
                    count += 1;
                }
                for footer in doc.query_selector_all(element, "footer")? {
                    if doc.query_selector(footer, ".footdef")?.is_some() {
                        doc.remove(footer);
                    }
                }
                return Ok(footnotes);
            }
            for sidenote in doc.query_selector_all(element, "span.sidenote")? {
                doc.remove(sidenote);
            }
            return Ok(footnotes);
        }
        let mut count: u64 = 1;
        for container in containers {
            let Some(content) = doc.query_selector(
                container,
                "span.footnote, span.sidenote, span.footnoteContent",
            )?
            else {
                continue;
            };
            let copy = doc.clone_node(content, true);
            footnotes.insert(
                count,
                Footnote {
                    content: copy,
                    original_id: count.to_string(),
                    refs: vec![format!("fnref:{count}")],
                },
            );
            let reference = create_footnote_reference(doc, count, &format!("fnref:{count}"))?;
            doc.replace_with(container, &[reference])?;
            count += 1;
        }
        Ok(footnotes)
    }

    /// `collectSidenotesColumn(element)`.
    pub(super) fn collect_sidenotes_column(
        &mut self,
        doc: &mut Document,
        element: NodeId,
    ) -> Result<Footnotes, ExtractError> {
        let mut footnotes = Footnotes::new();
        let mut columns = doc.query_selector_all(element, ".sidenotes-column")?;
        if columns.is_empty() {
            // The column is often a sibling of an ancestor of the article.
            let mut ancestor = doc.parent_element(element);
            for _ in 0..3 {
                let Some(a) = ancestor else { break };
                if !columns.is_empty() {
                    break;
                }
                columns = doc.query_selector_all(a, ":scope > .sidenotes-column")?;
                ancestor = doc.parent_element(a);
            }
        }
        if columns.is_empty() {
            return Ok(footnotes);
        }
        let mut count: u64 = 1;
        for column in columns {
            for sidenote in doc.query_selector_all(column, ".sidenote[id]")? {
                let id = doc.id_attr(sidenote);
                if id.is_empty() {
                    continue;
                }
                let digits: String = match doc.query_selector(sidenote, ".sidenote__id")? {
                    Some(span) => doc
                        .text_content(span)
                        .unwrap_or_default()
                        .chars()
                        .filter(char::is_ascii_digit)
                        .collect(),
                    None => String::new(),
                };
                let number = if digits.is_empty() {
                    count
                } else {
                    parse_int(&digits).map_or(count, |n| n as u64)
                };
                let content = doc.create_element("div");
                for node in doc.child_nodes(sidenote) {
                    if matches!(doc.node(node).kind, NodeKind::Element(_))
                        && (doc.class_list_contains(node, "sidenote__id")
                            || doc.class_list_contains(node, "sidenote__label")
                            || doc.class_list_contains(node, "sn-backref"))
                    {
                        continue;
                    }
                    let copy = doc.clone_node(node, true);
                    doc.append_child(content, copy)?;
                }
                self.remove_backrefs(doc, content)?;
                footnotes.insert(
                    number,
                    Footnote {
                        content,
                        original_id: id.to_lowercase(),
                        refs: Vec::new(),
                    },
                );
                count += 1;
            }
            doc.remove(column);
        }
        Ok(footnotes)
    }

    /// `collectAsideFootnotes(element)`.
    pub(super) fn collect_aside_footnotes(
        &mut self,
        doc: &mut Document,
        element: NodeId,
    ) -> Result<Footnotes, ExtractError> {
        let mut footnotes = Footnotes::new();
        for ol in doc.query_selector_all(element, "aside > ol[start]")? {
            let Some(aside) = doc.parent_element(ol) else {
                continue;
            };
            let number = match parse_int(&attr_or_empty(doc, ol, "start")) {
                Some(n) if n >= 1 => n as u64,
                _ => continue,
            };
            let items = doc.query_selector_all(ol, "li")?;
            if items.is_empty() {
                continue;
            }
            let content = doc.create_element("div");
            if items.len() == 1 {
                let copy = doc.clone_node(items[0], true);
                transfer_content(doc, copy, content)?;
            } else {
                for li in items {
                    let p = doc.create_element("p");
                    let copy = doc.clone_node(li, true);
                    transfer_content(doc, copy, p)?;
                    doc.append_child(content, p)?;
                }
            }
            footnotes.insert(
                number,
                Footnote {
                    content,
                    original_id: number.to_string(),
                    refs: Vec::new(),
                },
            );
            doc.remove(aside);
        }
        Ok(footnotes)
    }

    /// `collectHiddenAsideFootnotes(element)`.
    pub(super) fn collect_hidden_aside_footnotes(
        &mut self,
        doc: &mut Document,
        element: NodeId,
    ) -> Result<Footnotes, ExtractError> {
        let mut footnotes = Footnotes::new();
        let refs = doc.query_selector_all(element, "span[data-definition]")?;
        if refs.is_empty() {
            return Ok(footnotes);
        }
        let mut aside_map: HashMap<String, NodeId> = HashMap::new();
        for aside in doc.query_selector_all(element, "aside[id]")? {
            aside_map.insert(doc.id_attr(aside), aside);
        }
        let mut count: u64 = 1;
        for reference in refs {
            let Some(def_id) = attr(doc, reference, "data-definition").filter(|d| !d.is_empty())
            else {
                continue;
            };
            let Some(&aside) = aside_map.get(&def_id) else {
                continue;
            };
            let content = doc.create_element("div");
            transfer_content(doc, aside, content)?;
            doc.remove(aside);
            let ref_id = format!("fnref:{count}");
            footnotes.insert(
                count,
                Footnote {
                    content,
                    original_id: def_id.to_lowercase(),
                    refs: vec![ref_id.clone()],
                },
            );
            let new_ref = create_footnote_reference(doc, count, &ref_id)?;
            doc.replace_with(reference, &[new_ref])?;
            count += 1;
        }
        Ok(footnotes)
    }
}

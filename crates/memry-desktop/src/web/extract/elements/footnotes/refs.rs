//! Inline footnote references: the per-markup id extractors, the container a reference is
//! replaced as a whole, and the unmatched-footnote passes.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::elements::rule::{attr, attr_or_empty};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::trim;

use super::{FOOTNOTE_MARKER, Footnote, Footnotes, Handler, make_ref_id};

pub(super) struct InlineRefExtractor {
    pub selector: &'static str,
    pub extract: fn(&Document, NodeId) -> Result<String, ExtractError>,
}

const LINE: &str = r"[^\n\r\x{2028}\x{2029}]";

/// `/^footnoteref-(\d+)$/`.
static FOOTNOTEREF_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^footnoteref-([0-9]+)$").expect("static pattern"));
/// `/(?:cite_note|cite_ref)-(.+)/`.
static CITE_NOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?:cite_note|cite_ref)-({LINE}+)")).expect("static pattern")
});

/// `getHrefFragment(anchor)`: the lower-cased part after the last `#`.
pub(super) fn href_fragment(doc: &Document, anchor: Option<NodeId>) -> String {
    let href = anchor
        .map(|a| attr_or_empty(doc, a, "href"))
        .unwrap_or_default();
    href.rsplit('#').next().unwrap_or("").to_lowercase()
}

fn text_trim(doc: &Document, el: NodeId) -> String {
    trim(&doc.text_content(el).unwrap_or_default()).to_string()
}

pub(super) static INLINE_REF_EXTRACTORS: &[InlineRefExtractor] = &[
    InlineRefExtractor {
        selector: "sup.footnoteref",
        extract: |doc, el| {
            let link = doc.query_selector(el, "a[id^=\"footnoteref-\"]")?;
            Ok(link
                .and_then(|l| {
                    FOOTNOTEREF_ID
                        .captures(&doc.id_attr(l))
                        .map(|c| c[1].to_string())
                })
                .unwrap_or_default())
        },
    },
    InlineRefExtractor {
        selector: "a[id^=\"ref-link\"]",
        extract: |doc, el| Ok(text_trim(doc, el)),
    },
    InlineRefExtractor {
        selector: "a[role=\"doc-biblioref\"]",
        extract: |doc, el| {
            if let Some(rid) = attr(doc, el, "data-xml-rid").filter(|r| !r.is_empty()) {
                return Ok(rid);
            }
            let href = attr_or_empty(doc, el, "href");
            Ok(if href.starts_with("#core-R") {
                href.replacen("#core-", "", 1)
            } else {
                String::new()
            })
        },
    },
    InlineRefExtractor {
        selector: "a.footnote-anchor, span.footnote-hovercard-target a",
        extract: |doc, el| {
            Ok(doc
                .id_attr(el)
                .replacen("footnote-anchor-", "", 1)
                .to_lowercase())
        },
    },
    InlineRefExtractor {
        selector: "sup.reference",
        extract: |doc, el| {
            let mut id = String::new();
            for link in doc.query_selector_all(el, "a")? {
                let href = attr_or_empty(doc, link, "href");
                let last = href.rsplit('/').next().unwrap_or("");
                if let Some(m) = CITE_NOTE.captures(last) {
                    id = m[1].to_lowercase();
                }
            }
            Ok(id)
        },
    },
    InlineRefExtractor {
        selector: "sup[id^=\"fnref:\"], span[id^=\"fnref:\"]",
        extract: |doc, el| Ok(doc.id_attr(el).replacen("fnref:", "", 1).to_lowercase()),
    },
    InlineRefExtractor {
        selector: "sup[id^=\"fnr\"]",
        extract: |doc, el| Ok(doc.id_attr(el).replacen("fnr", "", 1).to_lowercase()),
    },
    InlineRefExtractor {
        selector: "sup.footnote-reference",
        extract: |doc, el| {
            let anchor = doc.query_selector(el, "a[href^=\"#\"]")?;
            Ok(href_fragment(doc, anchor))
        },
    },
    InlineRefExtractor {
        selector: "span.footnote-reference",
        extract: |doc, el| {
            let id = attr_or_empty(doc, el, "data-footnote-id");
            if !id.is_empty() {
                return Ok(id);
            }
            let own = doc.id_attr(el);
            Ok(if own.starts_with("fnref") {
                own.replacen("fnref", "", 1).to_lowercase()
            } else {
                String::new()
            })
        },
    },
    InlineRefExtractor {
        selector: "span.footnote-link",
        extract: |doc, el| Ok(attr_or_empty(doc, el, "data-footnote-id")),
    },
    InlineRefExtractor {
        selector: "a.citation",
        extract: |doc, el| Ok(text_trim(doc, el)),
    },
    InlineRefExtractor {
        selector: "a[id^=\"fnref\"]",
        extract: |doc, el| Ok(doc.id_attr(el).replacen("fnref", "", 1).to_lowercase()),
    },
    InlineRefExtractor {
        selector: "a[data-type=\"noteref\"]",
        extract: |doc, el| Ok(href_fragment(doc, Some(el))),
    },
];

/// `createFootnoteReference(footnoteNumber, refId)`: `<sup id><a href="#fn:N">N</a></sup>`.
pub(super) fn create_footnote_reference(
    doc: &mut Document,
    number: u64,
    ref_id: &str,
) -> Result<NodeId, ExtractError> {
    let sup = doc.create_element("sup");
    doc.set_attribute(sup, "id", ref_id);
    let link = doc.create_element("a");
    doc.set_attribute(link, "href", &format!("#fn:{number}"));
    doc.set_text_content(link, &number.to_string())?;
    doc.append_child(sup, link)?;
    Ok(sup)
}

/// `replaceContainerPreservingText(container, footnoteRef)`.
pub(super) fn replace_container_preserving_text(
    doc: &mut Document,
    container: NodeId,
    reference: NodeId,
) -> Result<(), ExtractError> {
    let mut direct_text = String::new();
    let mut has_child_elements = false;
    for node in doc.child_nodes(container) {
        match doc.node(node).kind {
            NodeKind::Text(_) => direct_text.push_str(&doc.text_content(node).unwrap_or_default()),
            NodeKind::Element(_) => has_child_elements = true,
            _ => {}
        }
    }
    let direct_text = trim(&direct_text).to_string();
    if !direct_text.is_empty() && has_child_elements {
        let fragment = doc.create_document_fragment();
        let text = doc.create_text_node(&direct_text);
        doc.append_child(fragment, text)?;
        doc.append_child(fragment, reference)?;
        doc.replace_with(container, &[fragment])
    } else {
        doc.replace_with(container, &[reference])
    }
}

/// `findOuterFootnoteContainer(el)`: climbs through spans and sups that hold only the reference.
pub(super) fn find_outer_footnote_container(doc: &Document, el: NodeId) -> NodeId {
    let mut current = el;
    let mut parent = doc.parent_element(el);
    while let Some(p) = parent {
        let tag = doc.tag_name(p).unwrap_or_default();
        if tag != "SPAN" && tag != "SUP" {
            break;
        }
        if tag == "SPAN" {
            let mut non_footnote = false;
            for child in doc.child_nodes(p) {
                if child == current {
                    continue;
                }
                match doc.node(child).kind {
                    NodeKind::Text(_) if !text_trim(doc, child).is_empty() => {
                        non_footnote = true;
                        break;
                    }
                    NodeKind::Element(_) if doc.tag_name(child).as_deref() != Some("SUP") => {
                        non_footnote = true;
                        break;
                    }
                    _ => {}
                }
            }
            if non_footnote {
                break;
            }
        }
        current = p;
        parent = doc.parent_element(p);
    }
    current
}

impl Handler {
    /// The `cite.ltx_cite` branch: one element can expand into several references.
    pub(super) fn expand_arxiv_citation(
        &mut self,
        doc: &mut Document,
        el: NodeId,
        footnotes: &mut Footnotes,
        by_original_id: &std::collections::HashMap<String, u64>,
    ) -> Result<(), ExtractError> {
        static BIB: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"bib\.bib([0-9]+)").expect("static pattern"));
        let mut refs = Vec::new();
        for link in doc.query_selector_all(el, "a")? {
            let Some(href) = attr(doc, link, "href").filter(|h| !h.is_empty()) else {
                continue;
            };
            let last = href.rsplit('/').next().unwrap_or("");
            let Some(m) = BIB.captures(last) else {
                continue;
            };
            let Some(&number) = by_original_id.get(&m[1].to_lowercase()) else {
                continue;
            };
            let data = footnotes.get_mut(&number).unwrap_or_else(|| unreachable!());
            let ref_id = make_ref_id(number, data.refs.len());
            data.refs.push(ref_id.clone());
            refs.push(create_footnote_reference(doc, number, &ref_id)?);
        }
        if !refs.is_empty() {
            let container = find_outer_footnote_container(doc, el);
            let fragment = doc.create_document_fragment();
            for (i, reference) in refs.into_iter().enumerate() {
                if i > 0 {
                    let space = doc.create_text_node(" ");
                    doc.append_child(fragment, space)?;
                }
                doc.append_child(fragment, reference)?;
            }
            doc.replace_with(container, &[fragment])?;
        }
        Ok(())
    }

    /// The "match remaining unmatched footnotes" fallback of `standardizeFootnotes`.
    pub(super) fn match_unmatched(
        &mut self,
        doc: &mut Document,
        element: NodeId,
        footnotes: &mut Footnotes,
    ) -> Result<(), ExtractError> {
        let unmatched: Vec<u64> = footnotes
            .iter()
            .filter(|(_, d)| d.refs.is_empty())
            .map(|(n, _)| *n)
            .collect();
        if unmatched.is_empty() {
            return Ok(());
        }
        let mut id_map = std::collections::HashMap::new();
        let mut num_map = std::collections::HashMap::new();
        for &n in &unmatched {
            id_map.insert(footnotes[&n].original_id.clone(), n);
            num_map.insert(n.to_string(), n);
        }
        let inside =
            |doc: &Document, pending: &[NodeId], el: NodeId| -> Result<bool, ExtractError> {
                Ok(doc.closest(el, "[id^=\"fnref:\"]")?.is_some()
                    || doc.closest(el, "#footnotes")?.is_some()
                    || pending.iter().any(|&g| doc.contains(g, el)))
            };
        let assign = |doc: &mut Document, el: NodeId, number: u64, data: &mut Footnote| {
            let ref_id = make_ref_id(number, data.refs.len());
            data.refs.push(ref_id.clone());
            let container = find_outer_footnote_container(doc, el);
            let reference = create_footnote_reference(doc, number, &ref_id)?;
            replace_container_preserving_text(doc, container, reference)
        };

        for link in doc.query_selector_all(element, "a[href*=\"#\"]")? {
            if doc.parent_node(link).is_none() || inside(doc, &self.pending_removals, link)? {
                continue;
            }
            let fragment = href_fragment(doc, Some(link));
            if fragment.is_empty() {
                continue;
            }
            let Some(&number) = id_map.get(&fragment) else {
                continue;
            };
            if !FOOTNOTE_MARKER.is_match(&text_trim(doc, link)) {
                continue;
            }
            let data = footnotes.get_mut(&number).unwrap_or_else(|| unreachable!());
            assign(doc, link, number, data)?;
        }

        if footnotes.values().any(|d| d.refs.is_empty()) {
            for el in doc.query_selector_all(element, "sup, span.footnote-ref")? {
                if doc.parent_node(el).is_none()
                    || doc.id_attr(el).starts_with("fnref:")
                    || doc.closest(el, "#footnotes")?.is_some()
                {
                    continue;
                }
                let text = text_trim(doc, el);
                let Some(m) = FOOTNOTE_MARKER.captures(&text) else {
                    continue;
                };
                let Some(&number) = num_map.get(&m[1]).or_else(|| id_map.get(&m[1])) else {
                    continue;
                };
                if !footnotes[&number].refs.is_empty() {
                    continue;
                }
                let data = footnotes.get_mut(&number).unwrap_or_else(|| unreachable!());
                assign(doc, el, number, data)?;
            }
        }
        Ok(())
    }
}

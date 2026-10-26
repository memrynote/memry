//! The rebuilt note list: `createFootnoteItem`, backlink detection and removal.

use crate::web::extract::constants::BLOCK_LEVEL_ELEMENTS;
use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::elements::rule::attr_or_empty;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::{tag_lower, transfer_content};
use crate::web::extract::utils::js::trim;

use super::{BACKREF_LEAD_TEXT, BACKREF_SYMBOLS, BACKREF_TRAIL_TEXT, Handler};

/// `/^#cite_ref-/` on the href.
fn is_cite_ref(href: &str) -> bool {
    href.starts_with("#cite_ref-")
}

/// `isBackrefLink(el)`.
pub(super) fn is_backref_link(doc: &Document, el: NodeId) -> bool {
    if tag_lower(doc, el) != "a" {
        return false;
    }
    let text =
        trim(&doc.text_content(el).unwrap_or_default()).replace(['\u{fe0e}', '\u{fe0f}'], "");
    if BACKREF_SYMBOLS.is_match(&text) || doc.class_list_contains(el, "footnote-backref") {
        return true;
    }
    is_cite_ref(&attr_or_empty(doc, el, "href"))
}

impl Handler {
    /// `removeBackrefs(el)`.
    pub(super) fn remove_backrefs(
        &self,
        doc: &mut Document,
        el: NodeId,
    ) -> Result<(), ExtractError> {
        for a in doc.query_selector_all(el, "a")? {
            if !is_backref_link(doc, a) {
                continue;
            }
            // The wrapping sup goes too when it held only this link.
            match doc.parent_element(a) {
                Some(parent)
                    if tag_lower(doc, parent) == "sup" && doc.child_element_count(parent) == 1 =>
                {
                    doc.remove(parent);
                }
                _ => doc.remove(a),
            }
        }
        while let Some(first) = doc.first_child(el)
            && matches!(doc.node(first).kind, NodeKind::Text(_))
        {
            let text = doc.text_content(first).unwrap_or_default();
            if !text.is_empty() && BACKREF_LEAD_TEXT.is_match(&text) && text.contains('^') {
                doc.remove(first);
            } else {
                break;
            }
        }
        while let Some(last) = doc.last_child(el)
            && matches!(doc.node(last).kind, NodeKind::Text(_))
        {
            if BACKREF_TRAIL_TEXT.is_match(&doc.text_content(last).unwrap_or_default()) {
                doc.remove(last);
            } else {
                break;
            }
        }
        Ok(())
    }

    /// `createFootnoteItem(footnoteNumber, content, refs)` for element content.
    pub(super) fn create_footnote_item(
        &self,
        doc: &mut Document,
        number: u64,
        content: NodeId,
        refs: &[String],
    ) -> Result<NodeId, ExtractError> {
        let item = doc.create_element("li");
        doc.set_attribute(item, "class", "footnote");
        doc.set_attribute(item, "id", &format!("fn:{number}"));
        let children = doc.children(content);
        let has_paragraphs = children.iter().any(|&c| tag_lower(doc, c) == "p");
        let has_block_children = children
            .iter()
            .any(|&c| BLOCK_LEVEL_ELEMENTS.contains(&tag_lower(doc, c).as_str()));
        if !has_paragraphs && !has_block_children {
            let paragraph = doc.create_element("p");
            transfer_content(doc, content, paragraph)?;
            self.remove_backrefs(doc, paragraph)?;
            doc.append_child(item, paragraph)?;
        } else if !has_paragraphs {
            for child in children {
                if is_backref_link(doc, child) {
                    continue;
                }
                let clone = doc.clone_node(child, true);
                self.remove_backrefs(doc, clone)?;
                doc.append_child(item, clone)?;
            }
        } else {
            for child in children {
                if is_backref_link(doc, child) {
                    continue;
                }
                if tag_lower(doc, child) == "p" {
                    if trim(&doc.text_content(child).unwrap_or_default()).is_empty()
                        && doc.query_selector(child, "img, br")?.is_none()
                    {
                        continue;
                    }
                    let new_p = doc.create_element("p");
                    transfer_content(doc, child, new_p)?;
                    self.remove_backrefs(doc, new_p)?;
                    doc.append_child(item, new_p)?;
                } else {
                    let clone = doc.clone_node(child, true);
                    self.remove_backrefs(doc, clone)?;
                    doc.append_child(item, clone)?;
                }
            }
        }
        let last_paragraph = doc.query_selector(item, "p:last-of-type")?.unwrap_or(item);
        for (index, ref_id) in refs.iter().enumerate() {
            let backlink = doc.create_element("a");
            doc.set_attribute(backlink, "href", &format!("#{ref_id}"));
            doc.set_attribute(backlink, "title", "return to article");
            doc.set_attribute(backlink, "class", "footnote-backref");
            let text = if index + 1 < refs.len() {
                "\u{21a9} "
            } else {
                "\u{21a9}"
            };
            doc.set_text_content(backlink, text)?;
            doc.append_child(last_paragraph, backlink)?;
        }
        Ok(item)
    }
}

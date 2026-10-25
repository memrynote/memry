//! Block-structure steps of `standardizeContent`: custom elements become divs, layout tables and
//! wrapper elements give way to their content.

use crate::web::extract::constants::{
    ALLOWED_EMPTY_ELEMENTS, BLOCK_ELEMENTS, BLOCK_ELEMENTS_SELECTOR, BLOCK_LEVEL_ELEMENTS,
    INLINE_ELEMENTS, PRESERVE_ELEMENTS,
};
use crate::web::extract::dom::node::node_type;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::{is_svg_element, tag_lower};
use crate::web::extract::utils::js::{to_lower, trim};

fn text_of(doc: &Document, el: NodeId) -> String {
    doc.text_content(el).unwrap_or_default()
}

fn has_text(doc: &Document, el: NodeId) -> bool {
    !trim(&text_of(doc, el)).is_empty()
}

/// `replaceCustomElements(element, doc)`: hyphenated tags other than the inline ones become
/// divs, so that they take part in block flattening.
pub fn replace_custom_elements(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let mut custom = Vec::new();
    for el in doc.query_selector_all(element, "*")? {
        let tag = tag_lower(doc, el);
        if tag.contains('-')
            && !INLINE_ELEMENTS.contains(&tag.as_str())
            && !is_svg_element(doc, el)?
        {
            custom.push(el);
        }
    }
    custom.reverse();
    for el in custom {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let div = doc.create_element("div");
        while let Some(child) = doc.first_child(el) {
            doc.append_child(div, child)?;
        }
        doc.replace_with(el, &[div])?;
    }
    Ok(())
}

/// `unwrapLayoutTables(element)`: a table whose only non-empty cell holds one block element is a
/// layout wrapper.
pub fn unwrap_layout_tables(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for table in doc.query_selector_all(element, "table")? {
        if doc.parent_node(table).is_none() {
            continue;
        }
        if doc
            .query_selector(table, "thead, tfoot, th, caption")?
            .is_some()
        {
            continue;
        }
        let cells = doc.query_selector_all(table, ":scope > tbody > tr > td, :scope > tr > td")?;
        let non_empty: Vec<NodeId> = cells.into_iter().filter(|&c| has_text(doc, c)).collect();
        if non_empty.len() != 1 {
            continue;
        }
        let children: Vec<NodeId> = doc
            .children(non_empty[0])
            .into_iter()
            .filter(|&c| has_text(doc, c))
            .collect();
        if children.len() == 1
            && BLOCK_LEVEL_ELEMENTS.contains(&tag_lower(doc, children[0]).as_str())
        {
            doc.replace_with(table, &[children[0]])?;
        }
    }
    Ok(())
}

/// Words in a class name that mark an element as meaningful structure.
fn has_semantic_class(class_name: &str) -> bool {
    let lower = to_lower(class_name);
    [
        "article",
        "main",
        "content",
        "footnote",
        "reference",
        "bibliography",
    ]
    .iter()
    .any(|w| lower.contains(w))
}

/// `hasDirectInlineContent(el)`: text or an inline element among the direct children.
fn has_direct_inline_content(doc: &Document, el: NodeId) -> bool {
    doc.child_nodes(el).into_iter().any(|child| {
        (doc.node_type(child) == node_type::TEXT && has_text(doc, child))
            || (doc.is_element(child)
                && INLINE_ELEMENTS.contains(&to_lower(&doc.node_name(child)).as_str()))
    })
}

/// `shouldPreserveElement(el)`.
fn should_preserve_element(doc: &Document, el: NodeId) -> Result<bool, ExtractError> {
    let tag = tag_lower(doc, el);
    if is_svg_element(doc, el)? || PRESERVE_ELEMENTS.contains(&tag.as_str()) {
        return Ok(true);
    }
    // Callout structure: div.callout[data-callout] and its children.
    if doc
        .get_attribute(el, "data-callout")
        .is_some_and(|v| !v.is_empty())
        || doc.closest(el, "[data-callout]")?.is_some()
    {
        return Ok(true);
    }
    if doc.get_attribute(el, "role").is_some_and(|role| {
        ["article", "main", "navigation", "banner", "contentinfo"].contains(&role.as_ref())
    }) {
        return Ok(true);
    }
    if has_semantic_class(&doc.class_name(el)) {
        return Ok(true);
    }
    Ok(doc.children(el).into_iter().any(|child| {
        PRESERVE_ELEMENTS.contains(&tag_lower(doc, child).as_str())
            || doc.get_attribute(child, "role").as_deref() == Some("article")
            || has_semantic_class(&doc.class_name(child))
    }))
}

/// `isWrapperElement(el)`.
fn is_wrapper_element(doc: &Document, el: NodeId) -> bool {
    if has_direct_inline_content(doc, el) {
        return false;
    }
    if !has_text(doc, el) {
        return true;
    }
    let children = doc.children(el);
    if children.is_empty() {
        return true;
    }
    if children
        .iter()
        .all(|&c| BLOCK_LEVEL_ELEMENTS.contains(&tag_lower(doc, c).as_str()))
    {
        return true;
    }
    let class_name = to_lower(&doc.class_name(el));
    if [
        "wrapper",
        "container",
        "layout",
        "row",
        "col",
        "grid",
        "flex",
        "outer",
        "inner",
        "content-area",
    ]
    .iter()
    .any(|w| class_name.contains(w))
    {
        return true;
    }
    // No direct text nodes with content, or only block-ish children.
    let has_text_nodes = doc
        .child_nodes(el)
        .into_iter()
        .any(|n| doc.node_type(n) == node_type::TEXT && has_text(doc, n));
    if !has_text_nodes {
        return true;
    }
    !children
        .iter()
        .any(|&c| INLINE_ELEMENTS.contains(&tag_lower(doc, c).as_str()))
}

/// Moves the children of `el` into a fragment and puts the fragment where `el` was.
fn unwrap_into_fragment(doc: &mut Document, el: NodeId) -> Result<(), ExtractError> {
    let fragment = doc.create_document_fragment();
    while let Some(child) = doc.first_child(el) {
        doc.append_child(fragment, child)?;
    }
    doc.replace_with(el, &[fragment])
}

/// Block ancestors of `el`: how deeply it nests in structural elements.
fn nesting_depth(doc: &Document, el: NodeId) -> usize {
    let mut depth = 0;
    let mut parent = doc.parent_element(el);
    while let Some(p) = parent {
        if BLOCK_ELEMENTS.contains(&tag_lower(doc, p).as_str()) {
            depth += 1;
        }
        parent = doc.parent_element(p);
    }
    depth
}

/// `processElement(el)`: unwraps, converts or removes one block element. True when it changed
/// the tree.
fn process_element(doc: &mut Document, root: NodeId, el: NodeId) -> Result<bool, ExtractError> {
    if doc.parent_node(el).is_none() || should_preserve_element(doc, el)? {
        return Ok(false);
    }
    let tag = tag_lower(doc, el);
    // 1. Truly empty.
    if !ALLOWED_EMPTY_ELEMENTS.contains(&tag.as_str())
        && doc.children(el).is_empty()
        && !has_text(doc, el)
    {
        doc.remove(el);
        return Ok(true);
    }
    // 2. Top level: more aggressive, children that are all non-inline merge up.
    if doc.parent_element(el) == Some(root) {
        let children = doc.children(el);
        let only_block = !children.is_empty()
            && !children
                .iter()
                .any(|&c| INLINE_ELEMENTS.contains(&tag_lower(doc, c).as_str()));
        if only_block {
            unwrap_into_fragment(doc, el)?;
            return Ok(true);
        }
    }
    // 3. A wrapper merges up.
    if is_wrapper_element(doc, el) {
        unwrap_into_fragment(doc, el)?;
        return Ok(true);
    }
    // 4. Only text and inline elements: a paragraph.
    let child_nodes = doc.child_nodes(el);
    let only_inline_or_text = !child_nodes.is_empty()
        && child_nodes.iter().all(|&c| {
            doc.node_type(c) == node_type::TEXT
                || (doc.is_element(c)
                    && INLINE_ELEMENTS.contains(&to_lower(&doc.node_name(c)).as_str()))
        });
    if only_inline_or_text && has_text(doc, el) {
        let p = doc.create_element("p");
        while let Some(child) = doc.first_child(el) {
            doc.append_child(p, child)?;
        }
        doc.replace_with(el, &[p])?;
        return Ok(true);
    }
    // 5. A single block child replaces its parent.
    let children = doc.children(el);
    if children.len() == 1 {
        let child = children[0];
        if BLOCK_ELEMENTS.contains(&tag_lower(doc, child).as_str())
            && !should_preserve_element(doc, child)?
        {
            doc.replace_with(el, &[child])?;
            return Ok(true);
        }
    }
    // 6. Nested in another block and without inline content of its own: merge up.
    if nesting_depth(doc, el) > 0 && !has_direct_inline_content(doc, el) {
        unwrap_into_fragment(doc, el)?;
        return Ok(true);
    }
    Ok(false)
}

/// `flattenWrapperElements(element, doc)`: passes over the top-level, the nested (deepest first)
/// and the remaining block elements until nothing changes.
pub fn flatten_wrapper_elements(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    loop {
        let mut keep_processing = false;

        // Top-level wrapper elements.
        let top: Vec<NodeId> = doc
            .children(element)
            .into_iter()
            .filter(|&c| BLOCK_ELEMENTS.contains(&tag_lower(doc, c).as_str()))
            .collect();
        for el in top {
            keep_processing |= process_element(doc, element, el)?;
        }

        // Remaining ones from deepest to shallowest; `sort` is stable like `Array#sort`.
        let mut ranked: Vec<(usize, NodeId)> = doc
            .query_selector_all(element, &BLOCK_ELEMENTS_SELECTOR)?
            .into_iter()
            .map(|el| (nesting_depth(doc, el), el))
            .collect();
        ranked.sort_by_key(|a| std::cmp::Reverse(a.0));
        for (_, el) in ranked {
            keep_processing |= process_element(doc, element, el)?;
        }

        // Final cleanup: blocks that only hold paragraphs, or wrappers that survived.
        for el in doc.query_selector_all(element, &BLOCK_ELEMENTS_SELECTOR)? {
            let children = doc.children(el);
            let only_paragraphs =
                !children.is_empty() && children.iter().all(|&c| tag_lower(doc, c) == "p");
            if only_paragraphs
                || (!should_preserve_element(doc, el)? && is_wrapper_element(doc, el))
            {
                unwrap_into_fragment(doc, el)?;
                keep_processing = true;
            }
        }
        if !keep_processing {
            return Ok(());
        }
    }
}

//! `standardizeElements`: the rule table (headings and the ARIA role rules), then the fixes for
//! `code > pre`, arXiv LaTeXML, tables, video and `lite-youtube`.
//!
//! The JS rule table starts with the math and code rules and has the image rules between the
//! heading and role rules; the raw LaTeX wrapper and the LaTeX image conversion open the
//! function.

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::headings::clean_heading;
use crate::web::extract::elements::math::base::{extract_latex_from_image_src, looks_like_latex};
use crate::web::extract::elements::math::raw::wrap_raw_latex_delimiters;
use crate::web::extract::elements::math::{self, create_clean_math_el};
use crate::web::extract::elements::rule::attr_or_empty;
use crate::web::extract::elements::rule::{Rule, Transform};
use crate::web::extract::elements::{code, images};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::{is_direct_table_child, tag_lower};
use crate::web::extract::utils::js::trim;

use super::lists;
use super::verso::merge_adjacent_verso_code_blocks;

/// One `ELEMENT_STANDARDIZATION_RULES` entry: every match is replaced by what `transform` makes.
fn apply_rule(
    doc: &mut Document,
    element: NodeId,
    selector: &str,
    transform: Transform,
) -> Result<(), ExtractError> {
    // A selector that fails to compile skips the rule, as the JS `try`/`catch` does.
    let Ok(matches) = doc.query_selector_all(element, selector) else {
        return Ok(());
    };
    for el in matches {
        let transformed = transform(doc, el)?;
        doc.replace_with(el, &[transformed])?;
    }
    Ok(())
}

fn apply_rules(doc: &mut Document, element: NodeId, rules: &[Rule]) -> Result<(), ExtractError> {
    for rule in rules {
        if let Some(fast_check) = rule.fast_check
            && doc.query_selector(element, fast_check)?.is_none()
        {
            continue;
        }
        apply_rule(doc, element, rule.selector, rule.transform)?;
    }
    Ok(())
}

/// `<code><pre><code>..</code></pre></code>` becomes `<pre><code>..</code></pre>`.
fn flatten_code_around_pre(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for pre in doc.query_selector_all(element, "code > pre")? {
        if let Some(outer) = doc.parent_element(pre)
            && doc.tag_name(outer).as_deref() == Some("CODE")
        {
            doc.replace_with(outer, &[pre])?;
        }
    }
    Ok(())
}

/// arXiv LaTeXML: an equation table becomes the `<math>` elements it holds, with the LaTeX as
/// their text.
fn convert_equation_tables(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let tables = doc.query_selector_all(
        element,
        "table.ltx_equation, table.ltx_eqn_table, table.ltx_equationgroup",
    )?;
    for table in tables {
        let maths = doc.query_selector_all(table, "math")?;
        if maths.is_empty() {
            continue;
        }
        let fragment = doc.create_document_fragment();
        for math in maths {
            let alttext = doc
                .get_attribute(math, "alttext")
                .unwrap_or_default()
                .into_owned();
            let latex = if alttext.is_empty() {
                match doc.query_selector(math, "annotation[encoding=\"application/x-tex\"]")? {
                    Some(annotation) => {
                        trim(&doc.text_content(annotation).unwrap_or_default()).to_string()
                    }
                    None => String::new(),
                }
            } else {
                alttext
            };
            if latex.is_empty() {
                continue;
            }
            let is_block = doc.get_attribute(math, "display").as_deref() == Some("block")
                || doc.class_list_contains(table, "ltx_equation")
                || doc.class_list_contains(table, "ltx_equationgroup");
            let clean = doc.create_element("math");
            doc.set_attribute(clean, "xmlns", "http://www.w3.org/1998/Math/MathML");
            doc.set_attribute(clean, "display", if is_block { "block" } else { "inline" });
            doc.set_attribute(clean, "data-latex", &latex);
            doc.set_text_content(clean, &latex)?;
            doc.append_child(fragment, clean)?;
        }
        if doc.has_child_nodes(fragment) {
            doc.replace_with(table, &[fragment])?;
        }
    }
    Ok(())
}

/// arXiv LaTeXML notes and cross references.
fn clean_latexml(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    // Hidden `ltx_note_outer` spans repeat the footnote mark and its "footnotemark:" text.
    for outer in doc.query_selector_all(element, "span.ltx_note_outer")? {
        doc.remove(outer);
    }
    // A cross reference keeps its number: the link becomes its text.
    for link in doc.query_selector_all(element, "a.ltx_ref")? {
        if doc
            .query_selector(link, "span.ltx_ref_tag, span.ltx_text.ltx_ref_tag")?
            .is_some()
        {
            let text = doc.text_content(link).unwrap_or_default();
            let node = doc.create_text_node(&text);
            doc.replace_with(link, &[node])?;
        }
    }
    Ok(())
}

/// Removes tables with no text and no media, and unwraps single-column layout tables.
fn clean_tables(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for table in doc.query_selector_all(element, "table")? {
        if doc.parent_node(table).is_none() {
            continue;
        }
        let cells = doc.query_selector_all(table, "td, th")?;
        if !cells.is_empty()
            && cells
                .iter()
                .all(|&c| trim(&doc.text_content(c).unwrap_or_default()).is_empty())
            && doc
                .query_selector(table, "img, picture, video, audio, iframe, svg, math")?
                .is_none()
        {
            doc.remove(table);
        }
    }
    for table in doc.query_selector_all(element, "table")? {
        if doc.parent_node(table).is_none() {
            continue;
        }
        let mut direct_cells = Vec::new();
        for cell in doc.query_selector_all(table, "td, th")? {
            if is_direct_table_child(doc, cell, table) {
                direct_cells.push(cell);
            }
        }
        // Data tables have direct header cells.
        if direct_cells
            .iter()
            .any(|&c| doc.tag_name(c).as_deref() == Some("TH"))
        {
            continue;
        }
        let mut direct_rows = Vec::new();
        for row in doc.query_selector_all(table, "tr")? {
            if is_direct_table_child(doc, row, table) {
                direct_rows.push(row);
            }
        }
        if direct_rows.is_empty() {
            continue;
        }
        let single_column = direct_rows.iter().all(|&tr| {
            direct_cells
                .iter()
                .filter(|&&c| doc.parent_node(c) == Some(tr))
                .count()
                <= 1
        });
        if !single_column {
            continue;
        }
        let fragment = doc.create_document_fragment();
        for cell in direct_cells {
            while let Some(child) = doc.first_child(cell) {
                doc.append_child(fragment, child)?;
            }
        }
        doc.replace_with(table, &[fragment])?;
    }
    Ok(())
}

/// `lite-youtube` becomes the iframe it would render. linkedom reflects `src`, `title` and
/// `allow` as attributes and keeps `width`, `height` and `frameBorder` as plain properties,
/// so only the first three reach the markup.
fn convert_lite_youtube(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for el in doc.query_selector_all(element, "lite-youtube")? {
        let video_id = doc
            .get_attribute(el, "videoid")
            .unwrap_or_default()
            .into_owned();
        if video_id.is_empty() {
            continue;
        }
        let iframe = doc.create_element("iframe");
        doc.set_attribute(
            iframe,
            "src",
            &format!("https://www.youtube.com/embed/{video_id}"),
        );
        let title = doc
            .get_attribute(el, "videotitle")
            .unwrap_or_default()
            .into_owned();
        doc.set_attribute(
            iframe,
            "title",
            if title.is_empty() {
                "YouTube video player"
            } else {
                &title
            },
        );
        doc.set_attribute(
            iframe,
            "allow",
            "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
        );
        doc.set_attribute(iframe, "allowfullscreen", "");
        doc.replace_with(el, &[iframe])?;
    }
    Ok(())
}

/// Images from LaTeX rendering services become `<math>`: the URL-encoded LaTeX of the `src`
/// (no domain allowlist), else an `alt` that holds LaTeX commands.
fn convert_latex_images(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for img in doc.query_selector_all(element, "img[src]")? {
        let src = attr_or_empty(doc, img, "src");
        if src.is_empty() {
            continue;
        }
        let mut latex = extract_latex_from_image_src(&src);
        if latex.is_none() {
            let alt = attr_or_empty(doc, img, "alt");
            if looks_like_latex(&alt) {
                latex = Some(alt);
            }
        }
        let Some(latex) = latex.filter(|l| !l.is_empty()) else {
            continue;
        };
        let alone_in_paragraph = doc.parent_element(img).is_some_and(|parent| {
            tag_lower(doc, parent) == "p" && doc.child_nodes(parent).len() == 1
        });
        let is_block = latex.contains("\\begin{") || alone_in_paragraph;
        let math = create_clean_math_el(doc, None, Some(&latex), is_block)?;
        doc.replace_with(img, &[math])?;
    }
    Ok(())
}

/// `standardizeElements(element, doc)`; `source` is the `doc` of the JS function, the document
/// the page was parsed into.
pub fn standardize_elements(
    doc: &mut Document,
    element: NodeId,
    source: NodeId,
) -> Result<(), ExtractError> {
    wrap_raw_latex_delimiters(doc, element, source)?;
    convert_latex_images(doc, element)?;
    apply_rules(doc, element, math::RULES)?;
    apply_rules(doc, element, code::RULES)?;
    apply_rule(doc, element, "h1, h2, h3, h4, h5, h6", clean_heading)?;
    apply_rules(doc, element, images::RULES)?;
    apply_rule(doc, element, lists::PARAGRAPH_SELECTOR, lists::paragraph)?;
    apply_rule(doc, element, lists::LIST_SELECTOR, lists::list)?;
    apply_rule(doc, element, lists::LIST_ITEM_SELECTOR, lists::list_item)?;

    flatten_code_around_pre(doc, element)?;
    convert_equation_tables(doc, element)?;
    clean_latexml(doc, element)?;
    clean_tables(doc, element)?;
    for video in doc.query_selector_all(element, "video:not([controls])")? {
        doc.set_attribute(video, "controls", "");
    }
    convert_lite_youtube(doc, element)?;
    merge_adjacent_verso_code_blocks(doc, element)
}

//! The passes of `removeByContentPattern` over the end of the content: section breadcrumbs,
//! trailing link lists, related posts, thin trailing sections, boilerplate, newsletter prompts,
//! author blocks, engagement counters and tag links.

use crate::web::extract::constants::CONTENT_ELEMENT_SELECTOR;
use crate::web::extract::dom::position::POSITION_FOLLOWING;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{Utf16Text, split_whitespace_runs, utf16_len, utf16_prefix};
use crate::web::extract::utils::text::count_words;

use super::Page;
use super::helpers::{
    is_or_contains_heading, remove_thin_preceding_section, remove_trailing_siblings,
    remove_trailing_with_cascade, text, trimmed, walk_up_isolated, words,
};
use super::regexes::{
    BOILERPLATE_PATTERNS, CTA_HEADING_PATTERN, INDEX_FILE_PATTERN, RELATED_HEADING_PATTERN,
    RELATED_INTRO_PATTERN, has_sentence_punctuation,
};

/// `new URL(href, url)`: the resolved URL, `None` when JS throws.
fn resolve(page: &Page, href: &str) -> Option<url::Url> {
    url::Url::parse(&page.url).ok()?.join(href).ok()
}

/// `host.replace(/^www\./, '')`.
fn strip_www(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

fn href(doc: &Document, el: NodeId) -> String {
    doc.get_attribute(el, "href")
        .map(|h| h.into_owned())
        .unwrap_or_default()
}

/// Section breadcrumbs and back links: a short element with a link to a parent path of the page.
pub(super) fn remove_section_breadcrumbs(
    doc: &mut Document,
    page: &Page,
) -> Result<(), ExtractError> {
    let main = page.main;
    let url_path = page
        .parsed_url
        .as_ref()
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    if url_path.is_empty() {
        return Ok(());
    }
    let first_heading = doc.query_selector(main, "h1, h2, h3")?;
    for el in doc.query_selector_all(main, "div, span, p, a[href]")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let el_text = trimmed(doc, el);
        if count_words(&el_text) > 10 {
            continue;
        }
        // A leaf-ish element: no block children.
        if !doc
            .query_selector_all(el, "p, div, section, article")?
            .is_empty()
        {
            continue;
        }
        let is_link = doc.matches(el, "a[href]")?;
        // A bare link embedded in prose is not a breadcrumb, except a back link before the
        // first heading.
        if is_link
            && let Some(parent) = doc.parent_element(el)
            && parent != main
            && trimmed(doc, parent) != el_text
        {
            if doc.closest(el, "p")?.is_some() {
                continue;
            }
            let Some(first_heading) = first_heading else {
                continue;
            };
            if doc.compare_document_position(el, first_heading) & POSITION_FOLLOWING == 0 {
                continue;
            }
        }
        let link = if is_link {
            Some(el)
        } else {
            doc.query_selector(el, "a[href]")?
        };
        let Some(link) = link else {
            continue;
        };
        let Some(resolved) = resolve(page, &href(doc, link)) else {
            continue;
        };
        let link_path = resolved.path();
        // A link to `index.html` of a parent directory counts as well.
        let link_dir = match link_path.rfind('/') {
            Some(i) => &link_path[..=i],
            None => link_path,
        };
        let last_segment = link_path.rsplit('/').next().unwrap_or("");
        let is_parent_index =
            INDEX_FILE_PATTERN.is_match(last_segment) && url_path.starts_with(link_dir);
        if link_path != "/"
            && link_path != url_path
            && (url_path.starts_with(link_path) || is_parent_index)
        {
            doc.remove(el);
        }
    }
    Ok(())
}

/// A heading and a list of purely off-site links as the last block (affiliate picks).
pub(super) fn remove_trailing_external_lists(
    doc: &mut Document,
    page: &Page,
) -> Result<(), ExtractError> {
    let main = page.main;
    let page_host = page
        .parsed_url
        .as_ref()
        .map(|u| strip_www(u.host_str().unwrap_or("")).to_string())
        .unwrap_or_default();
    if page_host.is_empty() {
        return Ok(());
    }
    for heading in doc.query_selector_all(main, "h2, h3, h4, h5, h6")? {
        if doc.parent_node(heading).is_none() {
            continue;
        }
        let Some(list) = doc.next_element_sibling(heading) else {
            continue;
        };
        let list_tag = doc.tag_name(list).unwrap_or_default();
        if list_tag != "UL" && list_tag != "OL" {
            continue;
        }
        let items: Vec<NodeId> = doc
            .children(list)
            .into_iter()
            .filter(|el| doc.tag_name(*el).as_deref() == Some("LI"))
            .collect();
        if items.len() < 2 {
            continue;
        }
        // Nothing meaningful may follow the list at any ancestor level up to the content.
        let mut trailing_content = false;
        let mut check = Some(list);
        while let Some(c) = check {
            if c == main {
                break;
            }
            let mut sibling = doc.next_element_sibling(c);
            while let Some(s) = sibling {
                if !trimmed(doc, s).is_empty() {
                    trailing_content = true;
                    break;
                }
                sibling = doc.next_element_sibling(s);
            }
            if trailing_content {
                break;
            }
            check = doc.parent_element(c);
        }
        if trailing_content {
            continue;
        }
        let mut all_external = true;
        for item in &items {
            let links = doc.query_selector_all(*item, "a[href]")?;
            if links.is_empty() {
                all_external = false;
                break;
            }
            let item_text = trimmed(doc, *item);
            let mut link_text_len = 0usize;
            for link in &links {
                link_text_len += utf16_len(&trimmed(doc, *link));
                if let Some(resolved) = resolve(page, &href(doc, *link))
                    && strip_www(resolved.host_str().unwrap_or("")) == page_host
                {
                    all_external = false;
                    break;
                }
            }
            if !all_external {
                break;
            }
            if (link_text_len as f64) < utf16_len(&item_text) as f64 * 0.6 {
                all_external = false;
                break;
            }
        }
        if !all_external {
            continue;
        }
        doc.remove(list);
        doc.remove(heading);
    }
    Ok(())
}

/// A trailing container whose children are all short, link-dense paragraphs.
pub(super) fn remove_trailing_related_posts(
    doc: &mut Document,
    page: &Page,
) -> Result<(), ExtractError> {
    let mut last_child = doc.last_element_child(page.main);
    while let Some(c) = last_child {
        if !matches!(doc.tag_name(c).as_deref(), Some("HR" | "BR")) {
            break;
        }
        last_child = doc.previous_element_sibling(c);
    }
    let Some(last_child) = last_child else {
        return Ok(());
    };
    if !matches!(
        doc.tag_name(last_child).as_deref(),
        Some("SECTION" | "DIV" | "ASIDE")
    ) {
        return Ok(());
    }
    let mut paras: Vec<NodeId> = Vec::new();
    let mut has_non_para = false;
    for child in doc.children(last_child) {
        if trimmed(doc, child).is_empty() {
            continue;
        }
        match doc.tag_name(child).as_deref() {
            Some("P") => paras.push(child),
            Some("BR") => {}
            _ => {
                has_non_para = true;
                break;
            }
        }
    }
    if paras.len() < 2 || has_non_para {
        return Ok(());
    }
    let mut all_link_dense = true;
    for p in &paras {
        let p_text = split_whitespace_runs(&trimmed(doc, *p)).join(" ");
        let links = doc.query_selector_all(*p, "a[href]")?;
        if links.is_empty() {
            all_link_dense = false;
            break;
        }
        let link_text_len: usize = links.iter().map(|l| utf16_len(&trimmed(doc, *l))).sum();
        if link_text_len as f64 / utf16_len(&p_text).max(1) as f64 <= 0.6 {
            all_link_dense = false;
            break;
        }
        let mut non_link_text = p_text.clone();
        for link in &links {
            // `split(linkText).join('')`; an empty needle splits between every character.
            let link_text = trimmed(doc, *link);
            if !link_text.is_empty() {
                non_link_text = non_link_text.split(link_text.as_str()).collect::<String>();
            }
        }
        if has_sentence_punctuation(&non_link_text) {
            all_link_dense = false;
            break;
        }
    }
    if all_link_dense {
        doc.remove(last_child);
    }
    Ok(())
}

/// The last direct children with a heading and little prose: CTAs and promos.
pub(super) fn remove_trailing_thin_sections(
    doc: &mut Document,
    page: &Page,
) -> Result<(), ExtractError> {
    let main = page.main;
    let total_words = count_words(&text(doc, main));
    if total_words <= 300 {
        return Ok(());
    }
    let mut trailing_els: Vec<NodeId> = Vec::new();
    let mut trailing_words = 0i64;
    let mut child = doc.last_element_child(main);
    while let Some(c) = child {
        // The standardized footnotes container sits at the end.
        if doc.id_attr(c) == "footnotes" {
            child = doc.previous_element_sibling(c);
            continue;
        }
        // An <hr> is a content boundary.
        if doc.tag_name(c).as_deref() == Some("HR") {
            trailing_els.push(c);
            break;
        }
        // SVG path data inflates word counts.
        let mut svg_words = 0usize;
        for svg in doc.query_selector_all(c, "svg")? {
            svg_words += words(doc, svg);
        }
        let child_words = count_words(&trimmed(doc, c)) as i64 - svg_words as i64;
        if child_words > 25 {
            break;
        }
        trailing_words += child_words;
        trailing_els.push(c);
        child = doc.previous_element_sibling(c);
    }
    if !trailing_els.is_empty() && (trailing_words as f64) < total_words as f64 * 0.15 {
        let mut has_heading = false;
        let mut has_content = false;
        for el in &trailing_els {
            has_heading |= is_or_contains_heading(doc, *el)?;
            has_content |= doc
                .query_selector(*el, &CONTENT_ELEMENT_SELECTOR)?
                .is_some();
        }
        // Several prose paragraphs mean a real conclusion.
        let prose_paragraphs = trailing_els
            .iter()
            .filter(|el| doc.tag_name(**el).as_deref() == Some("P") && words(doc, **el) > 5)
            .count();
        if has_heading && !has_content && prose_paragraphs < 2 {
            for el in trailing_els {
                doc.remove(el);
            }
        }
    }
    Ok(())
}

/// End-of-article boilerplate sentences and everything after them.
pub(super) fn remove_boilerplate(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    let main = page.main;
    let full_text = Utf16Text::new(&text(doc, main));
    for el in doc.query_selector_all(main, "p, div, span, section")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        if doc.closest(el, "pre, code")?.is_some() {
            continue;
        }
        let el_text = trimmed(doc, el);
        let el_words = count_words(&el_text);
        if !(1..=50).contains(&el_words) {
            continue;
        }
        for pattern in BOILERPLATE_PATTERNS.iter() {
            if !pattern.is_match(&el_text) {
                continue;
            }
            // An ancestor with next siblings to truncate, but not the single wrapper of the
            // whole content.
            let mut target = el;
            while let Some(parent) = doc.parent_element(target) {
                if parent == main || doc.next_element_sibling(target).is_some() {
                    break;
                }
                target = parent;
            }
            let target_text = text(doc, target);
            let target_pos = full_text.index_of(&target_text.encode_utf16().collect::<Vec<_>>());
            if target_pos < 200 {
                // Too high a wrapper to truncate from; a trailing orphan is removed directly.
                if target != el && doc.next_element_sibling(el).is_none() {
                    doc.remove(el);
                }
                continue;
            }
            remove_trailing_with_cascade(doc, target, main);
            break;
        }
    }
    Ok(())
}

/// "Related posts", "Read next" and "About the author" sections, found by their heading.
pub(super) fn remove_related_sections(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    let main = page.main;
    for heading in doc.query_selector_all(main, "h2, h3, h4, h5, h6")? {
        if doc.parent_node(heading).is_none() {
            continue;
        }
        let heading_text = trimmed(doc, heading);
        let is_cta = CTA_HEADING_PATTERN.is_match(&heading_text);
        if !is_cta && !RELATED_HEADING_PATTERN.is_match(&heading_text) {
            continue;
        }
        // After substantial content only.
        if page.index_of(&heading_text) < 500 {
            continue;
        }
        let target = walk_up_isolated(doc, heading, main);
        if target == heading {
            // A direct child: only CTA headings, which are never real content.
            if !is_cta {
                continue;
            }
            remove_trailing_siblings(doc, heading, true);
        } else {
            remove_thin_preceding_section(doc, target)?;
            remove_trailing_with_cascade(doc, target, main);
        }
        break;
    }
    Ok(())
}

/// "For more on ..." intros left behind after related embeds were removed.
pub(super) fn remove_related_intros(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    for el in doc.query_selector_all(page.main, "p")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let el_text = trimmed(doc, el);
        if !RELATED_INTRO_PATTERN.is_match(&el_text) {
            continue;
        }
        if count_words(&el_text) > 20 {
            continue;
        }
        if doc.query_selector(el, &CONTENT_ELEMENT_SELECTOR)?.is_some() {
            continue;
        }
        doc.remove(el);
    }
    Ok(())
}

/// Related-post card grids whose heading is already gone.
pub(super) fn remove_related_cards(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    let main = page.main;
    let content_word_count = page.content_words;
    for el in doc.query_selector_all(main, "div")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let children = doc.children(el);
        if children.len() < 2 {
            continue;
        }
        // A card holds an image and a heading or a link (earlier removals may have taken the
        // heading).
        let mut card_count = 0usize;
        for c in &children {
            if doc.query_selector(*c, "img, picture")?.is_some()
                && (doc.query_selector(*c, "h2, h3, h4")?.is_some()
                    || doc.query_selector(*c, "a[href]")?.is_some())
            {
                card_count += 1;
            }
        }
        if card_count < 2 || (card_count as f64) < children.len() as f64 * 0.7 {
            continue;
        }
        // After substantial content, not a top-of-page listing.
        let first_text = utf16_prefix(&trimmed(doc, children[0]), 30);
        if first_text.len() < 5 || page.content_text.index_of(&first_text) < 500 {
            continue;
        }
        // A grid that is a large share of the content (numbered takeaways) is content.
        let grid_words = words(doc, el);
        if content_word_count > 0 && grid_words as f64 / content_word_count as f64 > 0.3 {
            continue;
        }
        let target = walk_up_isolated(doc, el, main);
        if target == el {
            continue;
        }
        remove_thin_preceding_section(doc, target)?;
        remove_trailing_siblings(doc, target, true);
        break;
    }
    Ok(())
}

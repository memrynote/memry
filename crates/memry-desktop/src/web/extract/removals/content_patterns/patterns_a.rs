//! The passes of `removeByContentPattern` over the top of the content and its short metadata
//! elements, plus `removeEyebrowLabel`.

use crate::web::extract::constants::CONTENT_ELEMENT_SELECTOR;
use crate::web::extract::dom::position::POSITION_FOLLOWING;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{split_whitespace_runs, trim, utf16_len};
use crate::web::extract::utils::text::{count_words, normalize_text};

use super::Page;
use super::helpers::{
    HEADING_SELECTOR, is_breadcrumb_list, is_heading_tag, is_or_contains_heading, trimmed,
    walk_up_to_wrapper, words,
};
use super::regexes::{
    BYLINE_UPPERCASE_PATTERN, CONTENT_DATE_PATTERN, CONTENT_READ_TIME_PATTERN,
    ENDS_WITH_PUNCTUATION, LISTEN_WIDGET_PATTERN, METADATA_LABEL_PATTERN, PINNED_LABEL_PATTERN,
    PUNCTUATION_THEN_SPACE, RELATIVE_TIME_PATTERN, STARTS_WITH_BY_PATTERN, TIMEZONE_WIDGET_PATTERN,
    TOC_LABEL_PATTERN, has_sentence_punctuation, strip_byline, strip_date_only, strip_read_time,
};

/// `removeHeroHeader(mainContent, contentStart)`: the wrapper that groups a heading, a `<time>`
/// and a hero image above the prose.
fn remove_hero_header(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    let main = page.main;
    for time in doc.query_selector_all(main, "time")? {
        // Pre-content metadata only.
        if !page.is_pre_content(doc, time) {
            continue;
        }
        // The largest ancestor holding a heading and a time but under 30 words of prose.
        let mut best_block = None;
        let mut current = doc.parent_element(time);
        while let Some(c) = current {
            if c == main {
                break;
            }
            let has_heading_and_time = doc.query_selector(c, "h1, h2")?.is_some()
                && doc.query_selector(c, "time")?.is_some();
            if has_heading_and_time {
                let total_words = count_words(&trimmed(doc, c));
                // Words in metadata elements, without counting a nested one twice.
                let mut metadata_els: Vec<NodeId> = Vec::new();
                for el in doc.query_selector_all(c, "h1, h2, h3, time, [aria-label]")? {
                    if !metadata_els
                        .iter()
                        .any(|existing| doc.contains(*existing, el))
                    {
                        metadata_els.push(el);
                    }
                }
                let metadata_words: usize = metadata_els.iter().map(|el| words(doc, *el)).sum();
                // `proseWords` is signed in JS; only its comparison with 30 matters.
                let prose_words = total_words as i64 - metadata_words as i64;
                if prose_words < 30 {
                    best_block = Some(c);
                } else {
                    break;
                }
            }
            current = doc.parent_element(c);
        }
        if let Some(block) = best_block {
            doc.remove(block);
            return Ok(());
        }
    }
    Ok(())
}

/// `removeEyebrowLabel(mainContent)`: a short category label right before the first heading.
pub fn remove_eyebrow_label(doc: &mut Document, main: NodeId) -> Result<(), ExtractError> {
    let first_heading = match doc.query_selector(main, "h1")? {
        Some(h) => Some(h),
        None => doc.query_selector(main, "h2")?,
    };
    let Some(first_heading) = first_heading else {
        return Ok(());
    };
    // Climb while the heading (or its ancestor) is the first child, so an eyebrow beside an
    // ancestor of the h1 is found too.
    let mut current = first_heading;
    while let Some(parent) = doc.parent_element(current) {
        if parent == main || doc.previous_element_sibling(current).is_some() {
            break;
        }
        current = parent;
    }
    let Some(prev) = doc.previous_element_sibling(current) else {
        return Ok(());
    };
    let label = trimmed(doc, prev);
    let label_words = count_words(&label);
    if !(1..=6).contains(&label_words) {
        return Ok(());
    }
    if utf16_len(&label) > 40 {
        return Ok(());
    }
    if has_sentence_punctuation(&label) {
        return Ok(());
    }
    if CONTENT_DATE_PATTERN.is_match(&label) {
        return Ok(());
    }
    if doc
        .query_selector(
            prev,
            "img, picture, video, iframe, figure, table, pre, code, time, [datetime], \
             h1, h2, h3, h4, h5, h6, ul, ol, blockquote",
        )?
        .is_some()
    {
        return Ok(());
    }
    doc.remove(prev);
    Ok(())
}

/// The first four passes: a breadcrumb list, promotional banner links, the hero header and
/// "listen to this article" players.
pub(super) fn remove_top_widgets(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    let main = page.main;

    // A breadcrumb the CMS injected as the first list of the body.
    if let Some(first_list) = doc.query_selector(main, "ul, ol")?
        && is_breadcrumb_list(doc, first_list)?
    {
        let mut target = first_list;
        while let Some(parent) = doc.parent_element(target) {
            if parent == main || doc.child_element_count(parent) != 1 {
                break;
            }
            target = parent;
        }
        doc.remove(target);
    }

    // Announcement banners above the first h1: block `<a>` wrapping a div, short text.
    if let Some(first_h1) = doc.query_selector(main, "h1")? {
        for link in doc.query_selector_all(main, "a[href]")? {
            if doc.parent_node(link).is_none() {
                continue;
            }
            if doc.compare_document_position(link, first_h1) & POSITION_FOLLOWING == 0 {
                continue;
            }
            if doc.query_selector(link, "div")?.is_none() {
                continue;
            }
            if doc.query_selector(link, "img, picture, video")?.is_some() {
                continue;
            }
            let label = trimmed(doc, link);
            if count_words(&label) > 25 {
                continue;
            }
            if PUNCTUATION_THEN_SPACE.is_match(&label) {
                continue;
            }
            doc.remove(link);
        }
    }

    remove_hero_header(doc, page)?;

    // Audio and video players: "Listen to this article" widgets, and pre-content players in a
    // short container (player UI without prose).
    for media in doc.query_selector_all(main, "audio, video")? {
        if doc.parent_node(media).is_none() {
            continue;
        }
        let has_src = doc
            .get_attribute(media, "src")
            .is_some_and(|s| !s.is_empty());
        if !has_src && doc.query_selector(media, "source")?.is_none() {
            continue;
        }
        let mut container = media;
        while let Some(parent) = doc.parent_element(container) {
            if parent == main || count_words(&trimmed(doc, parent)) > 25 {
                break;
            }
            container = parent;
        }
        let container_text = trimmed(doc, container);
        let is_listen_widget = LISTEN_WIDGET_PATTERN.is_match(&container_text);
        let is_pre_content_player = !is_listen_widget
            && page.is_pre_content(doc, container)
            && count_words(&container_text) <= 25;
        if is_listen_widget || is_pre_content_player {
            doc.remove(container);
        }
    }
    Ok(())
}

/// A table of contents: a list of same-page anchor links near the top.
pub(super) fn remove_table_of_contents(
    doc: &mut Document,
    page: &Page,
) -> Result<(), ExtractError> {
    let main = page.main;
    for list in doc.query_selector_all(main, "ul, ol")? {
        if doc.parent_node(list).is_none() {
            continue;
        }
        if doc.closest(list, "#footnotes")?.is_some() {
            continue;
        }
        let list_text = trimmed(doc, list);
        let list_pos = page.index_of_prefix(&list_text);
        if list_pos < 0 || list_pos as f64 > page.content_text.unit_len() as f64 * 0.3 {
            continue;
        }
        let links = doc.query_selector_all(list, "a[href]")?;
        if links.len() < 3 {
            continue;
        }
        if doc
            .query_selector(list, &CONTENT_ELEMENT_SELECTOR)?
            .is_some()
        {
            continue;
        }
        // Same-page links: fragment-only, or the page's own URL with a fragment.
        let mut anchor_count = 0;
        for link in &links {
            let href = doc
                .get_attribute(*link, "href")
                .map(|h| h.into_owned())
                .unwrap_or_default();
            if href.starts_with('#') {
                anchor_count += 1;
            } else if let Some(page_url) = &page.parsed_url
                && href.contains('#')
                && let Ok(resolved) = page_url.join(&href)
                && resolved.path() == page_url.path()
                && resolved.host_str().unwrap_or("") == page_url.host_str().unwrap_or("")
            {
                anchor_count += 1;
            }
        }
        if anchor_count < 3 || (anchor_count as f64) / (links.len() as f64) < 0.8 {
            continue;
        }
        let mut target = list;
        while let Some(parent) = doc.parent_element(target) {
            if parent == main || doc.child_element_count(parent) != 1 {
                break;
            }
            target = parent;
        }
        // A preceding heading that labels the list.
        if let Some(prev) = doc.previous_element_sibling(target)
            && is_heading_tag(doc, prev)
            && TOC_LABEL_PATTERN.is_match(&trimmed(doc, prev))
        {
            doc.remove(prev);
        }
        // The horizontal rules that framed it.
        let prev_sib = doc.previous_element_sibling(target);
        let next_sib = doc.next_element_sibling(target);
        doc.remove(target);
        for rule in [prev_sib, next_sib].into_iter().flatten() {
            if doc.tag_name(rule).as_deref() == Some("HR") {
                doc.remove(rule);
            }
        }
        break;
    }
    Ok(())
}

/// The single pass over short `p, span, div, time` elements that removes the metadata around a
/// title: timezone widgets, "Pinned" labels, duplicates of the title and description, date
/// headers, category badges, bylines, read times, author-and-date lines and standalone dates.
pub(super) fn remove_metadata_elements(
    doc: &mut Document,
    page: &Page,
    normalized_title: &str,
    normalized_desc: &str,
) -> Result<(), ExtractError> {
    let main = page.main;
    let mut byline_found = false;
    let mut author_date_found = false;
    for el in doc.query_selector_all(main, "p, span, div, time")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let el_text = trimmed(doc, el);
        let el_words = count_words(&el_text);
        // Every check targets short metadata elements.
        if el_words > 15 || el_words == 0 {
            continue;
        }
        if doc.closest(el, "pre, code")?.is_some() {
            continue;
        }
        let tag = doc.tag_name(el).unwrap_or_default();
        let has_date = CONTENT_DATE_PATTERN.is_match(&el_text);

        // "Current time in" timezone widgets (NYT live blogs).
        if TIMEZONE_WIDGET_PATTERN.is_match(&el_text) && page.index_of(&el_text) <= 300 {
            let mut target = el;
            if let Some(parent) = doc.parent_element(target)
                && parent != main
            {
                target = parent;
            }
            doc.remove(target);
            continue;
        }
        if el_words == 1 && PINNED_LABEL_PATTERN.is_match(&el_text) {
            doc.remove(el);
            continue;
        }
        // Pre-content elements that repeat the title or description, on non-semantic markup.
        for normalized in [normalized_title, normalized_desc] {
            if !normalized.is_empty()
                && el_words >= 3
                && page.is_pre_content(doc, el)
                && normalize_text(&el_text) == normalized
            {
                doc.remove(el);
                break;
            }
        }
        if doc.parent_node(el).is_none() {
            continue;
        }
        // Date and category headers: "21 hours ago - Politics & Policy".
        if (tag == "DIV" || tag == "P")
            && (1..=10).contains(&el_words)
            && (has_date || RELATIVE_TIME_PATTERN.is_match(&el_text))
            && !METADATA_LABEL_PATTERN.is_match(&el_text)
            && !has_sentence_punctuation(&el_text)
            && page.is_pre_content(doc, el)
        {
            let mut long_block = false;
            for b in doc.query_selector_all(el, &format!("p, {HEADING_SELECTOR}"))? {
                if words(doc, b) > 8 {
                    long_block = true;
                    break;
                }
            }
            if !long_block {
                doc.remove(el);
                continue;
            }
        }
        // Category badges: an image link and a category link near the start.
        if tag == "DIV"
            && (1..=5).contains(&el_words)
            && !has_sentence_punctuation(&el_text)
            && page.is_pre_content(doc, el)
            && doc.query_selector(el, "img")?.is_some()
        {
            let links = doc.query_selector_all(el, "a[href]")?;
            if !links.is_empty() {
                let link_text_len: usize = links.iter().map(|l| utf16_len(&trimmed(doc, *l))).sum();
                if link_text_len as f64 / utf16_len(&el_text).max(1) as f64 >= 0.8 {
                    doc.remove(el);
                    continue;
                }
            }
        }
        // "By [Name]" near the start.
        if !byline_found
            && STARTS_WITH_BY_PATTERN.is_match(&el_text)
            && el_words >= 2
            && !ENDS_WITH_PUNCTUATION.is_match(&el_text)
            && page.is_pre_content(doc, el)
        {
            let target = walk_up_to_wrapper(doc, el, &el_text, main);
            doc.remove(target);
            byline_found = true;
            continue;
        }
        // Read time: with a date anywhere (no block children), without one only near the start.
        if CONTENT_READ_TIME_PATTERN.is_match(&el_text) {
            let qualifies = if has_date {
                doc.query_selector_all(el, "p, div, section, article")?
                    .is_empty()
            } else {
                el_words <= 5 && page.is_pre_content(doc, el)
            };
            if qualifies && trim(&strip_read_time(&el_text)).is_empty() {
                let target = if has_date {
                    el
                } else {
                    walk_up_to_wrapper(doc, el, &el_text, main)
                };
                doc.remove(target);
                continue;
            }
        }
        // Name and date in any order near the start.
        if !author_date_found
            && (2..=10).contains(&el_words)
            && has_date
            && !METADATA_LABEL_PATTERN.is_match(&el_text)
            && page.is_pre_content(doc, el)
        {
            let residual = strip_byline(&el_text);
            let residual = trim(&residual);
            if !residual.is_empty() {
                let name_words: Vec<&str> = split_whitespace_runs(residual)
                    .into_iter()
                    .filter(|w| !w.is_empty())
                    .collect();
                if (1..=4).contains(&name_words.len())
                    && name_words
                        .iter()
                        .all(|w| BYLINE_UPPERCASE_PATTERN.is_match(w))
                {
                    let target = walk_up_to_wrapper(doc, el, &el_text, main);
                    doc.remove(target);
                    author_date_found = true;
                    continue;
                }
            }
        }
        // A date and nothing else near the start.
        if has_date
            && el_words <= 5
            && page.is_pre_content(doc, el)
            && trim(&strip_date_only(&el_text)).is_empty()
        {
            let target = walk_up_to_wrapper(doc, el, &el_text, main);
            doc.remove(target);
            continue;
        }
    }
    Ok(())
}

/// A `<time>` in its own paragraph at either end of the content is the publish date; one inline
/// in prose stays.
pub(super) fn remove_boundary_time_elements(
    doc: &mut Document,
    page: &Page,
) -> Result<(), ExtractError> {
    let main = page.main;
    for time in doc.query_selector_all(main, "time")? {
        if doc.parent_node(time).is_none() {
            continue;
        }
        // Walk up through inline formatting wrappers only.
        let mut target = time;
        let mut target_text = trimmed(doc, target);
        while let Some(parent) = doc.parent_element(target) {
            if parent == main {
                break;
            }
            let parent_tag = doc
                .local_name(parent)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let parent_text = trimmed(doc, parent);
            if parent_tag == "p" && parent_text == target_text {
                target = parent;
                break;
            }
            if matches!(
                parent_tag.as_str(),
                "i" | "em" | "span" | "b" | "strong" | "small"
            ) && parent_text == target_text
            {
                target = parent;
                target_text = parent_text;
                continue;
            }
            break;
        }
        let target_text = trimmed(doc, target);
        if count_words(&target_text) > 10 {
            continue;
        }
        let pos = page.index_of(&target_text);
        let dist_from_end = page.distance_from_end(pos, &target_text);
        if pos > 200 && dist_from_end > 200 {
            continue;
        }
        doc.remove(target);
    }
    Ok(())
}

/// Blog metadata lists at either end: short `ul`/`ol`/`dl` of label-and-value items.
pub(super) fn remove_metadata_lists(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    let main = page.main;
    for list in doc.query_selector_all(main, "ul, ol, dl")? {
        if doc.parent_node(list).is_none() {
            continue;
        }
        if doc.closest(list, "#footnotes")?.is_some() {
            continue;
        }
        let is_dl = doc.tag_name(list).as_deref() == Some("DL");
        let item_tag = if is_dl { "DD" } else { "LI" };
        let items: Vec<NodeId> = doc
            .children(list)
            .into_iter()
            .filter(|el| doc.tag_name(*el).as_deref() == Some(item_tag))
            .collect();
        // A description list may hold one author block; ul and ol need two items.
        let min_items = if is_dl { 1 } else { 2 };
        if items.len() < min_items || items.len() > 8 {
            continue;
        }
        let list_text = trimmed(doc, list);
        let list_pos = page.index_of(&list_text);
        let dist_from_end = page.distance_from_end(list_pos, &list_text);
        if list_pos > 500 && dist_from_end > 500 {
            continue;
        }
        // A list introduced by a heading, or by a paragraph ending in ":", is content.
        if let Some(prev) = doc.previous_element_sibling(list) {
            if is_or_contains_heading(doc, prev)? {
                continue;
            }
            if trimmed(doc, prev).ends_with(':') {
                continue;
            }
        }
        let mut is_metadata = true;
        for item in &items {
            let item_text = trimmed(doc, *item);
            if count_words(&item_text) > 8 || ENDS_WITH_PUNCTUATION.is_match(&item_text) {
                is_metadata = false;
                break;
            }
        }
        if !is_metadata {
            continue;
        }
        if count_words(&list_text) > 30 {
            continue;
        }
        let target = walk_up_to_wrapper(doc, list, &list_text, main);
        doc.remove(target);
    }
    Ok(())
}

//! The last passes of `removeByContentPattern`: newsletter prompts, author and contact blocks,
//! engagement counters and tag-link blocks.

use crate::web::extract::constants::CONTENT_ELEMENT_SELECTOR;
use crate::web::extract::dom::Document;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::utf16_len;
use crate::web::extract::utils::text::count_words;

use super::Page;
use super::helpers::{is_newsletter_element, trimmed, walk_up_isolated, walk_up_to_wrapper};
use super::regexes::{
    AUTHOR_CONTACT_LABEL_PATTERN, EMAIL_PATTERN, PHONE_PATTERN, SHARE_AUTHOR_LABEL,
    SOCIAL_COUNTER_PATTERN, has_sentence_punctuation,
};

/// Newsletter signup sections, and signup lists.
pub(super) fn remove_newsletters(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    let main = page.main;
    for el in doc.query_selector_all(main, "div, section, aside")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        if doc.closest(el, "pre, code")?.is_some() {
            continue;
        }
        if !is_newsletter_element(doc, el, 60)? {
            continue;
        }
        // Up while the parent has little more content than the signup itself.
        let el_words = count_words(&trimmed(doc, el));
        let mut target = el;
        while let Some(parent) = doc.parent_element(target) {
            if parent == main {
                break;
            }
            let parent_words = count_words(&trimmed(doc, parent));
            if parent_words > el_words * 2 + 15 {
                break;
            }
            target = parent;
        }
        doc.remove(target);
        break;
    }
    for el in doc.query_selector_all(main, "ul")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        if !is_newsletter_element(doc, el, 30)? {
            continue;
        }
        doc.remove(el);
        break;
    }
    Ok(())
}

/// Author and contact blocks near the end, and author/share widgets.
pub(super) fn remove_author_blocks(doc: &mut Document, page: &Page) -> Result<(), ExtractError> {
    let main = page.main;
    for el in doc.query_selector_all(main, "div, section")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let el_text = trimmed(doc, el);
        let el_words = count_words(&el_text);
        if !(2..=40).contains(&el_words) {
            continue;
        }
        let pos = page.index_of_prefix(&el_text);
        if pos < 0 {
            continue;
        }
        if page.distance_from_end(pos, &el_text) > 300 {
            continue;
        }
        // A "Written by" or "Contact" label...
        let mut has_label = false;
        for child in doc.query_selector_all(el, "div, span, p, dt, dd, li")? {
            if AUTHOR_CONTACT_LABEL_PATTERN.is_match(&trimmed(doc, child)) {
                has_label = true;
                break;
            }
        }
        if !has_label {
            continue;
        }
        // ...next to an email, a phone number or a mailto link.
        let has_contact = EMAIL_PATTERN.is_match(&el_text)
            || PHONE_PATTERN.is_match(&el_text)
            || doc.query_selector(el, r#"a[href^="mailto:"]"#)?.is_some();
        if !has_contact {
            continue;
        }
        let target = walk_up_isolated(doc, el, main);
        doc.remove(target);
        break;
    }

    // Short "Author", "Share" or "Written by" widgets; avatars do not count as content.
    let no_img_selector = CONTENT_ELEMENT_SELECTOR.replacen("img, picture, ", "", 1);
    for el in doc.query_selector_all(main, "p, span, div")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let el_text = trimmed(doc, el);
        if !SHARE_AUTHOR_LABEL.is_match(&el_text) {
            continue;
        }
        let mut container = el;
        while let Some(parent) = doc.parent_element(container) {
            if parent == main || count_words(&trimmed(doc, parent)) > 15 {
                break;
            }
            container = parent;
        }
        if doc.query_selector(container, &no_img_selector)?.is_some() {
            continue;
        }
        doc.remove(container);
    }
    Ok(())
}

/// Engagement counters ("9 Likes") and trailing tag-link blocks.
pub(super) fn remove_engagement_and_tags(
    doc: &mut Document,
    page: &Page,
) -> Result<(), ExtractError> {
    let main = page.main;
    for el in doc.query_selector_all(main, "a, p, div, span")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let el_text = trimmed(doc, el);
        if !SOCIAL_COUNTER_PATTERN.is_match(&el_text) {
            continue;
        }
        let is_a = doc.tag_name(el).as_deref() == Some("A");
        if is_a && doc.get_attribute(el, "href").is_some_and(|h| !h.is_empty()) {
            continue;
        }
        if !is_a {
            let pos = page.index_of(&el_text);
            if page.distance_from_end(pos, &el_text) > 200 {
                continue;
            }
        }
        let target = walk_up_to_wrapper(doc, el, &el_text, main);
        doc.remove(target);
    }

    // Short blocks near the end that hold only links: tag clouds, category sections.
    for el in doc.query_selector_all(main, "div")? {
        if doc.parent_node(el).is_none() {
            continue;
        }
        let el_text = trimmed(doc, el);
        let el_words = count_words(&el_text);
        if !(1..=10).contains(&el_words) {
            continue;
        }
        if has_sentence_punctuation(&el_text) {
            continue;
        }
        if doc.query_selector(el, &CONTENT_ELEMENT_SELECTOR)?.is_some() {
            continue;
        }
        let pos = page.index_of(&el_text);
        if pos < 0 {
            continue;
        }
        if page.distance_from_end(pos, &el_text) > 300 {
            continue;
        }
        let links = doc.query_selector_all(el, "a[href]")?;
        if links.is_empty() {
            continue;
        }
        let link_text_len: usize = links.iter().map(|l| utf16_len(&trimmed(doc, *l))).sum();
        if (link_text_len as f64 / utf16_len(&el_text).max(1) as f64) < 0.8 {
            continue;
        }
        doc.remove(el);
    }
    Ok(())
}

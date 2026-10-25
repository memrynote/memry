//! Port of `dist/removals/scoring.js` (`ContentScorer`), number for number.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::constants::{
    BLOCK_ELEMENTS_SELECTOR, FOOTNOTE_INLINE_REFERENCES, FOOTNOTE_LIST_SELECTORS,
};
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, WS_BODY, parse_int, to_lower, trim, utf16_len};
use crate::web::extract::utils::text::count_words;

const CONTENT_INDICATORS: &[&str] = &[
    "admonition",
    "article",
    "content",
    "entry",
    "image",
    "img",
    "font",
    "figure",
    "figcaption",
    "pre",
    "main",
    "post",
    "story",
    "table",
];

const NAVIGATION_INDICATORS: &[&str] = &[
    "advertisement",
    "all rights reserved",
    "banner",
    "cookie",
    "comments",
    "copyright",
    "follow me",
    "follow us",
    "footer",
    "header",
    "homepage",
    "login",
    "menu",
    "more articles",
    "more like this",
    "most read",
    "nav",
    "navigation",
    "newsletter",
    "popular",
    "privacy",
    "recommended",
    "register",
    "related",
    "responses",
    "share",
    "sidebar",
    "sign in",
    "sign up",
    "signup",
    "social",
    "sponsored",
    "subscribe",
    "terms",
    "trending",
];

/// Classes that lower the score of a block without removing it on their own.
const NON_CONTENT_PATTERNS: &[&str] = &[
    "advert",
    "ad-",
    "ads",
    "banner",
    "cookie",
    "copyright",
    "footer",
    "header",
    "homepage",
    "menu",
    "nav",
    "newsletter",
    "popular",
    "privacy",
    "recommended",
    "related",
    "rights",
    "share",
    "sidebar",
    "social",
    "sponsored",
    "subscribe",
    "terms",
    "trending",
    "widget",
];

const MONTHS3: &str = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

/// An indicator as a regex: each space is `\s+`.
fn indicator_source(indicator: &str) -> String {
    indicator
        .split(' ')
        .map(regex::escape)
        .collect::<Vec<_>>()
        .join(&format!("{WS}+"))
}

/// `navigationIndicatorRegexes`: `\bindicator\b`, tested on lowercased text.
static NAVIGATION_INDICATOR_RES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    NAVIGATION_INDICATORS
        .iter()
        .map(|i| {
            Regex::new(&format!(r"(?-u:\b){}(?-u:\b)", indicator_source(i)))
                .expect("static pattern")
        })
        .collect()
});

/// `navigationHeadingPattern`: any indicator as a substring, ASCII case-insensitive.
static NAVIGATION_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    let alternatives: Vec<String> = NAVIGATION_INDICATORS
        .iter()
        .map(|i| {
            i.split(' ')
                .map(|w| format!("(?i-u:{w})"))
                .collect::<Vec<_>>()
                .join(&format!("{WS}+"))
        })
        .collect();
    Regex::new(&alternatives.join("|")).expect("static pattern")
});

/// `tocHeadingPattern`.
static TOC_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        "^(?i-u:(?:table of )?contents)$|^(?i-u:on this page)$|^(?i-u:in this (?:article|guide|post))$",
    )
    .expect("static pattern")
});

/// `socialProfilePattern`, without the lookahead alternatives (see `SOCIAL_LOOKAHEAD`).
static SOCIAL_SIMPLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u:\b)(?i-u:linkedin\.com/(?:in|company)/|instagram\.com/[A-Za-z0-9_]|threads\.net/[A-Za-z0-9_]|mastodon\.[A-Za-z0-9_])",
    )
    .expect("static pattern")
});
/// The alternatives `twitter\.com\/(?!intent\b)\w`, `x\.com\/(?!intent\b)\w` and
/// `facebook\.com\/(?!share\b)\w`: the regex finds the host and one word character, the
/// lookahead is checked on the text from that character.
static SOCIAL_LOOKAHEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?i-u:(twitter\.com|x\.com|facebook\.com)/[A-Za-z0-9_])")
        .expect("static pattern")
});

/// `socialProfilePattern.test(href)`.
fn social_profile_match(href: &str) -> bool {
    if SOCIAL_SIMPLE.is_match(href) {
        return true;
    }
    let mut at = 0;
    while let Some(caps) = SOCIAL_LOOKAHEAD.captures_at(href, at) {
        let whole = caps.get(0).expect("group 0");
        let forbidden: &[u8] = if caps[1].eq_ignore_ascii_case("facebook.com") {
            b"share"
        } else {
            b"intent"
        };
        // The match ends after the first word character; the lookahead starts at it.
        let rest = &href.as_bytes()[whole.end() - 1..];
        let blocked = rest.len() >= forbidden.len()
            && rest[..forbidden.len()].eq_ignore_ascii_case(forbidden)
            && rest
                .get(forbidden.len())
                .is_none_or(|b| !(b.is_ascii_alphanumeric() || *b == b'_'));
        if !blocked {
            return true;
        }
        let step = href[whole.start()..]
            .chars()
            .next()
            .map_or(1, char::len_utf8);
        at = whole.start() + step;
    }
    false
}

/// `datePattern`: a month and day, no year, no leading `\b`.
static DATE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "(?:(?i-u:(?:{MONTHS3})[a-z]*){WS}+[0-9]{{1,2}}|[0-9]{{1,2}}(?i-u:(?:st|nd|rd|th)?){WS}+(?i-u:(?:{MONTHS3})[a-z]*))"
    ))
    .expect("static pattern")
});
/// `bylinePattern`.
static BYLINE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?-u:\b)By{WS}+[A-Z]")).expect("static pattern"));
/// `contentDatePattern`: month, day and year.
static CONTENT_DATE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "(?-u:\\b)(?:(?i-u:(?:{MONTHS3})[a-z]*){WS}+[0-9]{{1,2}},?{WS}+[0-9]{{4}}|[0-9]{{1,2}}(?i-u:(?:st|nd|rd|th)?){WS}+(?i-u:(?:{MONTHS3})[a-z]*),?{WS}+[0-9]{{4}})(?-u:\\b)"
    ))
    .expect("static pattern")
});
/// `contentAuthorPattern`.
static CONTENT_AUTHOR_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "(?-u:\\b)(?i-u:(?:by|written by|author:)){WS}+[A-Za-z{WS_BODY}]+(?-u:\\b)"
    ))
    .expect("static pattern")
});

fn text_of(doc: &Document, el: NodeId) -> String {
    doc.text_content(el).unwrap_or_default()
}

fn count_tag(doc: &Document, el: NodeId, tag: &str) -> usize {
    doc.get_elements_by_tag_name(el, tag).len()
}

fn attr_or_empty(doc: &Document, el: NodeId, name: &str) -> String {
    doc.get_attribute(el, name)
        .map(|v| v.into_owned())
        .unwrap_or_default()
}

fn commas(text: &str) -> f64 {
    text.matches(',').count() as f64
}

/// `ContentScorer.scoreElement(element)`.
pub fn score_element(doc: &Document, element: NodeId) -> Result<f64, ExtractError> {
    let text = text_of(doc, element);
    let words = count_words(&text);
    let mut score = words as f64;

    score += (count_tag(doc, element, "p") * 10) as f64;
    score += commas(&text);

    // Penalize high image density.
    let images = count_tag(doc, element, "img");
    let image_density = images as f64 / words.max(1) as f64;
    score -= image_density * 3.0;

    let style = attr_or_empty(doc, element, "style");
    let align = attr_or_empty(doc, element, "align");
    if style.contains("float: right") || style.contains("text-align: right") || align == "right" {
        score += 5.0;
    }

    if CONTENT_DATE_PATTERN.is_match(&text) {
        score += 10.0;
    }
    if CONTENT_AUTHOR_PATTERN.is_match(&text) {
        score += 10.0;
    }

    let class_name = to_lower(&doc.class_name(element));
    if class_name.contains("content")
        || class_name.contains("article")
        || class_name.contains("post")
    {
        score += 15.0;
    }

    if doc
        .query_selector(element, &FOOTNOTE_INLINE_REFERENCES)?
        .is_some()
    {
        score += 10.0;
    }
    if doc
        .query_selector(element, &FOOTNOTE_LIST_SELECTORS)?
        .is_some()
    {
        score += 10.0;
    }

    score -= (count_tag(doc, element, "table") * 5) as f64;

    if doc.tag_name(element).as_deref() == Some("TD")
        && let Some(table) = doc.closest(element, "table")?
    {
        let table_width = parse_int(&attr_or_empty(doc, table, "width")).unwrap_or(0);
        let table_align = attr_or_empty(doc, table, "align");
        let table_class = to_lower(&doc.class_name(table));
        let is_table_layout = table_width > 400
            || table_align == "center"
            || table_class.contains("content")
            || table_class.contains("article");
        if is_table_layout {
            let cells = doc.get_elements_by_tag_name(table, "td");
            let cell_index = cells.iter().position(|c| *c == element);
            // `indexOf` is -1 for a cell of a nested table, which is not a centre cell.
            if let Some(i) = cell_index
                && i > 0
                && i + 1 < cells.len()
            {
                score += 10.0;
            }
        }
    }

    // Link density scales the score down, capped at half.
    let mut link_text_length = 0usize;
    for link in doc.get_elements_by_tag_name(element, "a") {
        link_text_length += utf16_len(&text_of(doc, link));
    }
    let text_length = utf16_len(&text).max(1);
    let link_density = (link_text_length as f64 / text_length as f64).min(0.5);
    score *= 1.0 - link_density;
    Ok(score)
}

/// `ContentScorer.findBestElement(elements, minScore)`.
pub fn find_best_element(
    doc: &Document,
    elements: &[NodeId],
    min_score: f64,
) -> Result<Option<NodeId>, ExtractError> {
    let mut best = None;
    let mut best_score = 0.0;
    for &element in elements {
        let score = score_element(doc, element)?;
        if score > best_score {
            best_score = score;
            best = Some(element);
        }
    }
    Ok(if best_score > min_score { best } else { None })
}

/// `ContentScorer.scoreAndRemove(doc, debug, debugRemovals, mainContent)`.
pub fn score_and_remove(
    doc: &mut Document,
    root: NodeId,
    main: Option<NodeId>,
) -> Result<(), ExtractError> {
    let mut to_remove: Vec<NodeId> = Vec::new();
    let mut marked: HashSet<NodeId> = HashSet::new();
    for element in doc.query_selector_all(root, &BLOCK_ELEMENTS_SELECTOR)? {
        if marked.contains(&element) {
            continue;
        }
        // The ancestors of the content would disconnect it.
        if let Some(main) = main
            && doc.contains(element, main)
        {
            continue;
        }
        // Code structure is not page navigation.
        if doc.closest(element, "pre")?.is_some()
            || doc.closest(element, "[data-defuddle]")?.is_some()
        {
            continue;
        }
        // A cell's content is structural; the table is still scored as a whole.
        if doc.closest(element, "td, th")?.is_some() {
            continue;
        }
        if is_likely_content(doc, element)? {
            continue;
        }
        if score_non_content_block(doc, element)? < 0.0 {
            marked.insert(element);
            to_remove.push(element);
        }
    }
    for element in to_remove {
        doc.remove(element);
    }
    Ok(())
}

/// `ContentScorer.isLikelyContent(element)`.
pub fn is_likely_content(doc: &Document, element: NodeId) -> Result<bool, ExtractError> {
    let role = doc.get_attribute(element, "role");
    if let Some(role) = role
        && matches!(&*role, "article" | "main" | "contentinfo")
    {
        return Ok(true);
    }
    let class_name = to_lower(&doc.class_name(element));
    let id = to_lower(&doc.id_attr(element));
    for indicator in CONTENT_INDICATORS {
        if class_name.contains(indicator) || id.contains(indicator) {
            return Ok(true);
        }
    }
    if doc
        .query_selector(element, "pre, table, figure, picture")?
        .is_some()
    {
        return Ok(true);
    }

    let text = text_of(doc, element);
    let words = count_words(&text);

    // A wrapper whose only content is a section heading (page builders): content, unless the
    // heading is navigation or a table-of-contents label.
    if let Some(heading) = doc.query_selector(element, "h1, h2, h3, h4, h5, h6")? {
        let heading_text = trim(&text_of(doc, heading)).to_string();
        if !heading_text.is_empty() && heading_text == trim(&text) {
            let lower = to_lower(&heading_text);
            if !NAVIGATION_HEADING.is_match(&lower) && !TOC_HEADING.is_match(&lower) {
                return Ok(true);
            }
        }
    }

    // A navigation heading ("Related articles") makes a block non-content even with prose,
    // unless it is a page-level wrapper (1000 words or more).
    if words < 1000 {
        let mut has_navigation_heading = false;
        for heading in doc.query_selector_all(element, "h1, h2, h3, h4, h5, h6")? {
            let heading_text = to_lower(trim(&text_of(doc, heading)));
            if NAVIGATION_HEADING.is_match(&heading_text) {
                has_navigation_heading = true;
                break;
            }
        }
        if has_navigation_heading {
            if words < 200 {
                return Ok(false);
            }
            let link_count = count_tag(doc, element, "a");
            if link_count as f64 / words.max(1) as f64 > 0.2 {
                return Ok(false);
            }
        }
    }

    if is_card_grid(doc, element, words)? {
        return Ok(false);
    }

    // Small blocks with social profile links: author bios and widgets.
    if words < 80 {
        for link in doc.get_elements_by_tag_name(element, "a") {
            let href = to_lower(&attr_or_empty(doc, link, "href"));
            if social_profile_match(&href) {
                return Ok(false);
            }
        }
    }

    let paragraphs = count_tag(doc, element, "p");
    let list_items = count_tag(doc, element, "li");
    let content_blocks = paragraphs + list_items;
    if words > 50 && content_blocks > 1 {
        return Ok(true);
    }
    if words > 100 {
        return Ok(true);
    }
    if words > 30 && content_blocks > 0 {
        return Ok(true);
    }
    // Prose without <p> (transcript segments in divs and spans).
    if words >= 10 && text.contains(['.', '?', '!']) {
        let link_count = count_tag(doc, element, "a");
        if (link_count as f64 / words as f64) < 0.1 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `ContentScorer.scoreNonContentBlock(element)`: negative for a block that is likely not
/// content.
pub fn score_non_content_block(doc: &Document, element: NodeId) -> Result<f64, ExtractError> {
    // Footnote lists and their descendants are never scored down. A selector error ends the
    // check, as the empty `catch` does.
    let footnote = (|| -> Result<bool, ExtractError> {
        Ok(doc.matches(element, &FOOTNOTE_LIST_SELECTORS)?
            || doc
                .query_selector(element, &FOOTNOTE_LIST_SELECTORS)?
                .is_some()
            || doc.closest(element, &FOOTNOTE_LIST_SELECTORS)?.is_some())
    })();
    if footnote.unwrap_or(false) {
        return Ok(0.0);
    }

    let mut score = 0.0;
    let text = text_of(doc, element);
    let words = count_words(&text);
    if words < 3 {
        return Ok(0.0);
    }

    // Prose has commas; navigation and boilerplate do not.
    score += commas(&text);

    let text_lower = to_lower(&text);
    let indicator_matches = NAVIGATION_INDICATOR_RES
        .iter()
        .filter(|re| re.is_match(&text_lower))
        .count();
    score -= (indicator_matches * 10) as f64;

    let link_elements = doc.get_elements_by_tag_name(element, "a");
    let links = link_elements.len();
    let link_density = links as f64 / words.max(1) as f64;
    if link_density > 0.5 {
        score -= 15.0;
    }

    // Card groups and nav sections: several links that are most of a short text.
    if links > 1 && words < 80 {
        let link_text_length: usize = link_elements
            .iter()
            .map(|l| utf16_len(&text_of(doc, *l)))
            .sum();
        let total = utf16_len(&text);
        if total > 0 && link_text_length as f64 / total as f64 > 0.8 {
            score -= 15.0;
        }
    }

    let lists = count_tag(doc, element, "ul") + count_tag(doc, element, "ol");
    if lists > 0 && links > lists * 3 {
        score -= 10.0;
    }

    if words < 80 {
        for link in &link_elements {
            let href = to_lower(&attr_or_empty(doc, *link, "href"));
            if social_profile_match(&href) {
                score -= 15.0;
                break;
            }
        }
    }

    // "By Author Name · March 4, 2026": needs both an attribution and a date.
    if words < 15 && BYLINE_PATTERN.is_match(&text) && DATE_PATTERN.is_match(&text) {
        score -= 10.0;
    }

    if is_card_grid(doc, element, words)? {
        score -= 15.0;
    }

    let class_name = to_lower(&doc.class_name(element));
    let id = to_lower(&doc.id_attr(element));
    for pattern in NON_CONTENT_PATTERNS {
        if class_name.contains(pattern) || id.contains(pattern) {
            score -= 8.0;
        }
    }
    Ok(score)
}

/// `ContentScorer.isCardGrid(element, words)`: three or more headings and two or more images
/// with under 20 words of prose per heading.
pub fn is_card_grid(doc: &Document, element: NodeId, words: usize) -> Result<bool, ExtractError> {
    if !(3..500).contains(&words) {
        return Ok(false);
    }
    let headings = doc.query_selector_all(element, "h2, h3, h4")?;
    if headings.len() < 3 {
        return Ok(false);
    }
    if doc.query_selector_all(element, "img")?.len() < 2 {
        return Ok(false);
    }
    let heading_words: usize = headings
        .iter()
        .map(|h| count_words(&text_of(doc, *h)))
        .sum();
    // `words - headingWordCount` is signed in JS.
    let prose_per_heading = (words as f64 - heading_words as f64) / headings.len() as f64;
    Ok(prose_per_heading < 20.0)
}

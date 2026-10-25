//! `getPublished`, `getTimeElement`, `isLinkedToOtherPage` and `parseDateText`.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use super::meta_tags::{MetaAttr, get_meta_content, valid};
use super::schema_property::get_schema_property;
use crate::web::extract::defuddle::schema_org::MetaTag;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::trim;
use crate::web::extract::utils::json::JsValue;

/// JS `\s`.
const WS: &str = r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
const MONTHS: &str =
    "January|February|March|April|May|June|July|August|September|October|November|December";

/// `\b` and the `i` flag are ASCII in a non-Unicode JS regex, so both are pinned to ASCII here.
static DAY_MONTH_YEAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?-u:\b)([0-9]{{1,2}}){WS}+((?i-u:{MONTHS})){WS}+([0-9]{{4}})(?-u:\b)"
    ))
    .expect("static pattern")
});
static MONTH_DAY_YEAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?-u:\b)((?i-u:{MONTHS})){WS}+([0-9]{{1,2}}),?{WS}+([0-9]{{4}})(?-u:\b)"
    ))
    .expect("static pattern")
});

/// `MONTH_MAP[name.toLowerCase()]`.
fn month_number(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "january" => "01",
        "february" => "02",
        "march" => "03",
        "april" => "04",
        "may" => "05",
        "june" => "06",
        "july" => "07",
        "august" => "08",
        "september" => "09",
        "october" => "10",
        "november" => "11",
        _ => "12",
    }
}

/// `parseDateText`: "26 February 2025" or "February 26, 2025" anywhere in the text, as an ISO
/// timestamp at midnight UTC; the empty string when there is none.
pub fn parse_date_text(text: &str) -> String {
    if let Some(m) = DAY_MONTH_YEAR.captures(text) {
        return format!(
            "{}-{}-{:0>2}T00:00:00+00:00",
            &m[3],
            month_number(&m[2]),
            &m[1]
        );
    }
    if let Some(m) = MONTH_DAY_YEAR.captures(text) {
        return format!(
            "{}-{}-{:0>2}T00:00:00+00:00",
            &m[3],
            month_number(&m[1]),
            &m[2]
        );
    }
    String::new()
}

/// `isLinkedToOtherPage`: `el` sits in an `<a>` that links to a different page of the same site,
/// which marks a related-post card whose date is not the article's.
fn is_linked_to_other_page(
    doc: &Document,
    el: NodeId,
    page_url: &str,
) -> Result<bool, ExtractError> {
    if page_url.is_empty() {
        return Ok(false);
    }
    let Some(anchor) = doc.closest(el, "a[href]")? else {
        return Ok(false);
    };
    let href = doc
        .get_attribute(anchor, "href")
        .map(|h| trim(&h).to_string())
        .unwrap_or_default();
    if href.is_empty() || href.starts_with('#') {
        return Ok(false);
    }
    let (Ok(current), Ok(target)) = (
        Url::parse(page_url),
        Url::parse(page_url).and_then(|base| base.join(&href)),
    ) else {
        return Ok(false);
    };
    if target.origin().ascii_serialization() != current.origin().ascii_serialization() {
        return Ok(false);
    }
    let norm = |path: &str| path.trim_end_matches('/').to_string();
    Ok(norm(target.path()) != norm(current.path()))
}

/// `getTimeElement`: the first `<time>` not inside a link to another page.
fn get_time_element(doc: &Document, url: &str) -> Result<String, ExtractError> {
    for element in doc.query_selector_all(doc.root(), "time")? {
        if is_linked_to_other_page(doc, element, url)? {
            continue;
        }
        let datetime = doc
            .get_attribute(element, "datetime")
            .map(|d| trim(&d).to_string());
        let content = match datetime.filter(|d| !d.is_empty()) {
            Some(d) => d,
            None => trim(&doc.text_content(element).unwrap_or_default()).to_string(),
        };
        if !content.is_empty() {
            return Ok(content);
        }
    }
    Ok(String::new())
}

/// The `scan` closure of `getPublished`: up to three siblings from `start`.
fn scan(
    doc: &Document,
    start: Option<NodeId>,
    forward: bool,
    children_only: bool,
) -> Result<String, ExtractError> {
    let mut sibling = start;
    for _ in 0..3 {
        let Some(current) = sibling else { break };
        for child in doc.query_selector_all(current, "p, time")? {
            let parsed = parse_date_text(trim(&doc.text_content(child).unwrap_or_default()));
            if !parsed.is_empty() {
                return Ok(parsed);
            }
        }
        // Above the title only <p>/<time> dates count: header blocks there mix in breadcrumbs
        // whose loose text is navigation.
        if !children_only {
            let parsed = parse_date_text(trim(&doc.text_content(current).unwrap_or_default()));
            if !parsed.is_empty() {
                return Ok(parsed);
            }
        }
        sibling = if forward {
            doc.next_element_sibling(current)
        } else {
            doc.previous_element_sibling(current)
        };
    }
    Ok(String::new())
}

/// `getPublished`.
pub fn get_published(
    doc: &Document,
    schema: &JsValue,
    meta: &[MetaTag],
    url: &str,
) -> Result<String, ExtractError> {
    let abbr_title = || -> Result<String, ExtractError> {
        Ok(
            match doc.query_selector(doc.root(), r#"abbr[itemprop="datePublished"]"#)? {
                Some(el) => doc
                    .get_attribute(el, "title")
                    .map(|t| trim(&t).to_string())
                    .unwrap_or_default(),
                None => String::new(),
            },
        )
    };
    let sources: [&dyn Fn() -> Result<String, ExtractError>; 6] = [
        &|| Ok(get_schema_property(schema, "datePublished")),
        &|| Ok(get_meta_content(meta, MetaAttr::Name, "publishDate")),
        &|| {
            Ok(get_meta_content(
                meta,
                MetaAttr::Property,
                "article:published_time",
            ))
        },
        &abbr_title,
        &|| get_time_element(doc, url),
        &|| Ok(get_meta_content(meta, MetaAttr::Name, "sailthru.date")),
    ];
    for source in sources {
        if let Some(found) = valid(source()?) {
            return Ok(found);
        }
    }
    // Date text near the article heading, in both directions: many layouts put the date in a
    // byline below the <h1>, others in a header block above it.
    if let Some(h1) = doc.query_selector(doc.root(), "h1")? {
        let below = valid(scan(doc, doc.next_element_sibling(h1), true, false)?);
        if let Some(found) = below {
            return Ok(found);
        }
        if let Some(found) = valid(scan(doc, doc.previous_element_sibling(h1), false, true)?) {
            return Ok(found);
        }
    }
    Ok(String::new())
}

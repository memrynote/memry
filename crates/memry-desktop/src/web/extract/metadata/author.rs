//! `getAuthor` and its helpers: meta tags, JSON-LD, `rel="author"`, author elements and bylines
//! near the heading.

use super::dates::parse_date_text;
use super::meta_tags::{
    MetaAttr, get_meta_content, get_meta_contents, is_placeholder_value, valid,
};
use super::schema_property::get_schema_property;
use crate::web::extract::defuddle::schema_org::MetaTag;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{is_js_whitespace, to_lower, trim, utf16_len};
use crate::web::extract::utils::text::collapse_whitespace;

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `.replace(/\u00a0/g, ' ')`.
fn nbsp_to_space(s: &str) -> String {
    s.replace('\u{a0}', " ")
}

/// First occurrences of `Vec::dedup` by value, as `[...new Set(list)]`.
fn unique(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in list {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// `/^by\s+/i` removed.
fn strip_by_prefix(s: &str) -> &str {
    let mut chars = s.char_indices();
    let starts = matches!(chars.next(), Some((_, 'b' | 'B')))
        && matches!(chars.next(), Some((_, 'y' | 'Y')));
    if !starts {
        return s;
    }
    let rest = &s[2..];
    let trimmed = rest.trim_start_matches(is_js_whitespace);
    if trimmed.len() == rest.len() {
        s
    } else {
        trimmed
    }
}

/// One match of `/\(?\s*https?:\/\/\S+\s*\)?/i` starting exactly at `at`; returns its end.
fn url_match_at(chars: &[char], at: usize) -> Option<usize> {
    let skip_ws = |mut i: usize| {
        while i < chars.len() && is_js_whitespace(chars[i]) {
            i += 1;
        }
        i
    };
    let literal = |i: usize, text: &str| -> Option<usize> {
        let mut j = i;
        for expected in text.chars() {
            let c = *chars.get(j)?;
            if !c.eq_ignore_ascii_case(&expected) {
                return None;
            }
            j += 1;
        }
        Some(j)
    };
    let mut starts = vec![at];
    if chars.get(at) == Some(&'(') {
        starts.insert(0, at + 1);
    }
    starts.into_iter().find_map(|s| {
        let mut i = literal(skip_ws(s), "http")?;
        if matches!(chars.get(i), Some('s' | 'S')) {
            i += 1;
        }
        i = literal(i, "://")?;
        let body_end = (i..chars.len())
            .find(|&k| is_js_whitespace(chars[k]))
            .unwrap_or(chars.len());
        if body_end == i {
            return None;
        }
        let after_ws = skip_ws(body_end);
        Some(if chars.get(after_ws) == Some(&')') {
            after_ws + 1
        } else {
            after_ws
        })
    })
}

/// `s.replace(/\(?\s*https?:\/\/\S+\s*\)?/gi, '')`.
fn strip_urls(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        match url_match_at(&chars, i) {
            Some(end) => i = end,
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// `s.replace(/,?\s+and\s+/gi, ', ')`.
fn normalize_and(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let ws_end = |mut i: usize| {
        while i < chars.len() && is_js_whitespace(chars[i]) {
            i += 1;
        }
        i
    };
    let match_at = |at: usize| -> Option<usize> {
        let start = if chars.get(at) == Some(&',') {
            at + 1
        } else {
            at
        };
        let after_ws = ws_end(start);
        if after_ws == start {
            return None;
        }
        let word_end = after_ws + 3;
        let word: String = chars.get(after_ws..word_end)?.iter().collect();
        if !word.eq_ignore_ascii_case("and") {
            return None;
        }
        let end = ws_end(word_end);
        (end > word_end).then_some(end)
    };
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        match match_at(i) {
            Some(end) => {
                out.push_str(", ");
                i = end;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// `s.replace(/\s*[-–—|]\s*$/g, '')`.
fn strip_trailing_separator(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let ws_end = |mut i: usize| {
        while i < chars.len() && is_js_whitespace(chars[i]) {
            i += 1;
        }
        i
    };
    for i in 0..=chars.len() {
        let at = ws_end(i);
        if matches!(chars.get(at), Some('-' | '\u{2013}' | '\u{2014}' | '|'))
            && ws_end(at + 1) == chars.len()
        {
            return chars[..i].iter().collect();
        }
    }
    s.to_string()
}

/// `cleanAuthorString`.
pub fn clean_author_string(s: &str) -> String {
    let stripped = strip_by_prefix(s);
    let without_urls = strip_urls(stripped);
    let anded = normalize_and(&without_urls);
    trim(&strip_trailing_separator(&anded)).to_string()
}

/// `/(.*),\s(.*)/.exec(s)` as `(group 1, group 2)`: the last `,` followed by whitespace on the
/// first line that has one. `.` stops at a line terminator, `\s` does not.
fn split_last_comma(s: &str) -> Option<(String, String)> {
    let chars: Vec<char> = s.chars().collect();
    let mut line_start = 0usize;
    while line_start <= chars.len() {
        let line_end = (line_start..chars.len())
            .find(|&k| is_line_terminator(chars[k]))
            .unwrap_or(chars.len());
        let comma = (line_start..line_end)
            .rev()
            .find(|&p| chars[p] == ',' && chars.get(p + 1).is_some_and(|c| is_js_whitespace(*c)));
        if let Some(p) = comma {
            let second_start = p + 2;
            let second_end = (second_start..chars.len())
                .find(|&k| is_line_terminator(chars[k]))
                .unwrap_or(chars.len());
            return Some((
                chars[line_start..p].iter().collect(),
                chars[second_start.min(second_end)..second_end]
                    .iter()
                    .collect(),
            ));
        }
        line_start = line_end + 1;
    }
    None
}

/// `/^By\s+([A-Z].+)$/i` and `bylineMatch[1].trim()`.
fn match_byline(text: &str) -> Option<String> {
    let mut chars = text.chars();
    if !chars.next()?.eq_ignore_ascii_case(&'b') || !chars.next()?.eq_ignore_ascii_case(&'y') {
        return None;
    }
    let rest = &text[2..];
    let name = rest.trim_start_matches(is_js_whitespace);
    if name.len() == rest.len() {
        return None;
    }
    let mut name_chars = name.chars();
    if !name_chars.next()?.is_ascii_alphabetic() {
        return None;
    }
    let tail: &str = name_chars.as_str();
    if tail.is_empty() || tail.chars().any(is_line_terminator) {
        return None;
    }
    Some(trim(name).to_string())
}

/// `extractByline`: "By ..." text in the element or its `p`, `span` and `address` children.
fn extract_byline(doc: &Document, el: NodeId) -> Result<Option<String>, ExtractError> {
    let mut candidates = vec![el];
    candidates.extend(doc.query_selector_all(el, "p, span, address")?);
    for candidate in candidates {
        let text = nbsp_to_space(trim(&doc.text_content(candidate).unwrap_or_default()));
        let length = utf16_len(&text);
        if length > 0
            && length < 50
            && let Some(found) = match_byline(&text)
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// The clone of `el` without its `script`, `style` and `noscript` descendants.
fn visible_clone(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let clone = doc.clone_node(el, true);
    for hidden in doc.query_selector_all(clone, "script, style, noscript")? {
        doc.remove(hidden);
    }
    Ok(clone)
}

fn normalized_text(doc: &Document, el: NodeId) -> String {
    trim(&collapse_whitespace(
        &doc.text_content(el).unwrap_or_default(),
    ))
    .to_string()
}

/// `getVisibleText`.
fn get_visible_text(doc: &mut Document, el: NodeId) -> Result<String, ExtractError> {
    let clone = visible_clone(doc, el)?;
    Ok(normalized_text(doc, clone))
}

/// `getAuthorName`: a short child's text over the concatenated text of an author card.
fn get_author_name(doc: &mut Document, el: NodeId) -> Result<String, ExtractError> {
    let clone = visible_clone(doc, el)?;
    let text = normalized_text(doc, clone);
    if text.is_empty() {
        return Ok(String::new());
    }
    for child in doc.query_selector_all(clone, "span, a, p")? {
        let child_text = normalized_text(doc, child);
        let length = utf16_len(&child_text);
        if (2..=50).contains(&length) && child_text != text {
            return Ok(child_text);
        }
    }
    Ok(if utf16_len(&text) <= 100 {
        text
    } else {
        String::new()
    })
}

/// `addDomAuthor`.
fn add_dom_author(collected: &mut Vec<String>, value: &str) {
    if value.is_empty() {
        return;
    }
    for part in value.split(',') {
        let cleaned = trim(&collapse_whitespace(part)).to_string();
        let lower = to_lower(&cleaned);
        if !cleaned.is_empty()
            && lower != "author"
            && lower != "authors"
            && !is_placeholder_value(&cleaned)
        {
            collected.push(cleaned);
        }
    }
}

fn limit_ten(mut authors: Vec<String>) -> Vec<String> {
    authors.truncate(10);
    authors
}

/// Step 4 of `getAuthor`: a name next to the first heading, from a date-adjacent sibling or a
/// "By ..." line within three levels of the heading.
fn author_near_heading(doc: &Document, h1: NodeId) -> Result<Option<String>, ExtractError> {
    let mut sibling = doc.next_element_sibling(h1);
    for _ in 0..3 {
        let Some(current) = sibling else { break };
        let sibling_text = trim(&doc.text_content(current).unwrap_or_default()).to_string();
        let children = doc.query_selector_all(current, "p, time")?;
        let has_date_child = children.iter().any(|&el| {
            !parse_date_text(trim(&doc.text_content(el).unwrap_or_default())).is_empty()
        });
        let has_sibling_date = !parse_date_text(&sibling_text).is_empty() || has_date_child;
        if has_sibling_date {
            let links = doc.query_selector_all(current, "a")?;
            if links.len() == 1 {
                let link_text =
                    nbsp_to_space(trim(&doc.text_content(links[0]).unwrap_or_default()));
                let length = utf16_len(&link_text);
                if length > 0 && length < 100 && parse_date_text(&link_text).is_empty() {
                    return Ok(Some(link_text));
                }
            }
            if has_date_child && utf16_len(&sibling_text) < 300 {
                for &p in &children {
                    if doc.tag_name(p).as_deref() != Some("P") {
                        continue;
                    }
                    let p_text = nbsp_to_space(trim(&doc.text_content(p).unwrap_or_default()));
                    let length = utf16_len(&p_text);
                    if length > 0 && length < 150 && parse_date_text(&p_text).is_empty() {
                        return Ok(Some(p_text));
                    }
                }
            }
        }
        sibling = doc.next_element_sibling(current);
    }

    let mut scope = Some(h1);
    for _ in 0..3 {
        let Some(current) = scope else { break };
        for step in [
            Document::previous_element_sibling,
            Document::next_element_sibling,
        ] {
            let mut candidate = step(doc, current);
            for _ in 0..3 {
                let Some(el) = candidate else { break };
                if let Some(found) = extract_byline(doc, el)? {
                    return Ok(Some(found));
                }
                candidate = step(doc, el);
            }
        }
        scope = doc.parent_element(current);
    }
    Ok(None)
}

/// `getAuthor`.
pub fn get_author(
    doc: &mut Document,
    schema: &crate::web::extract::utils::json::JsValue,
    meta: &[MetaTag],
) -> Result<String, ExtractError> {
    let meta_candidates = [
        (MetaAttr::Name, "sailthru.author"),
        (MetaAttr::Property, "article:author"),
        (MetaAttr::Property, "author"),
        (MetaAttr::Name, "author"),
        (MetaAttr::Name, "byl"),
        (MetaAttr::Name, "authorList"),
    ];
    if let Some(authors) = meta_candidates
        .iter()
        .find_map(|(attr, name)| valid(get_meta_content(meta, *attr, name)))
    {
        let cleaned = clean_author_string(&authors);
        if !cleaned.is_empty() {
            return Ok(cleaned);
        }
    }

    // Research-paper conventions.
    let mut paper_authors: Vec<String> = get_meta_contents(meta, MetaAttr::Name, "citation_author")
        .into_iter()
        .filter(|s| !is_placeholder_value(s))
        .collect();
    if paper_authors.is_empty() {
        paper_authors = get_meta_contents(meta, MetaAttr::Property, "dc.creator")
            .into_iter()
            .filter(|s| !is_placeholder_value(s))
            .collect();
    }
    if !paper_authors.is_empty() {
        let names: Vec<String> = paper_authors
            .iter()
            .map(|s| {
                if !s.contains(',') {
                    return trim(s).to_string();
                }
                match split_last_comma(s) {
                    Some((family, given)) => format!("{given} {family}"),
                    None => trim(s).to_string(),
                }
            })
            .collect();
        return Ok(names.join(", "));
    }

    // Schema.org data, deduplicated when it is a list.
    let mut schema_authors = get_schema_property(schema, "author.name");
    if schema_authors.is_empty() {
        schema_authors = get_schema_property(schema, "author.[].name");
    }
    if !schema_authors.is_empty() {
        let parts: Vec<String> = schema_authors
            .split(',')
            .map(|part| trim(part).to_string())
            .filter(|part| !part.is_empty() && !is_placeholder_value(part))
            .collect();
        if !parts.is_empty() {
            return Ok(limit_ten(unique(parts)).join(", "));
        }
    }

    // `rel="author"` runs before `.author`, so a container that wraps a bio cannot add its text.
    let rel_author =
        doc.query_selector_all(doc.root(), r#"a[rel~="author"], address[rel~="author"]"#)?;
    if !rel_author.is_empty() && rel_author.len() <= 3 {
        let mut names = Vec::new();
        for el in rel_author {
            let text = get_visible_text(doc, el)?;
            let lower = to_lower(&text);
            if !text.is_empty()
                && utf16_len(&text) < 100
                && lower != "author"
                && lower != "authors"
                && !is_placeholder_value(&text)
            {
                names.push(text);
            }
        }
        let names = unique(names);
        if !names.is_empty() {
            return Ok(names.join(", "));
        }
    }

    // Author elements; ambiguous selectors with too many matches (testimonials, comments) are skipped.
    let selectors: [(&str, Option<usize>); 4] = [
        (r#"[itemprop="author"]"#, None),
        (".author", Some(3)),
        (r#"[href*="/author/"]"#, Some(3)),
        (".authors a", Some(3)),
    ];
    let mut collected = Vec::new();
    for (selector, max_matches) in selectors {
        let matches = doc.query_selector_all(doc.root(), selector)?;
        if max_matches.is_some_and(|max| matches.len() > max) {
            continue;
        }
        for el in matches {
            let name = get_author_name(doc, el)?;
            add_dom_author(&mut collected, &name);
        }
    }
    if !collected.is_empty() {
        let trimmed: Vec<String> = collected
            .iter()
            .map(|name| trim(name).to_string())
            .filter(|name| !name.is_empty())
            .collect();
        let mut authors = unique(trimmed);
        if authors.len() > 1 {
            // Drop entries that contain a shorter entry already present.
            let all = authors.clone();
            authors.retain(|a| !all.iter().any(|b| b != a && a.contains(b.as_str())));
        }
        if !authors.is_empty() {
            return Ok(limit_ten(authors).join(", "));
        }
    }

    if let Some(h1) = doc.query_selector(doc.root(), "h1")?
        && let Some(found) = author_near_heading(doc, h1)?
    {
        return Ok(found);
    }
    Ok(String::new())
}

//! `memry_help_search` and `memry_help_read`: the user guide `build.rs` bundles, split into
//! `##`/`###` sections and searched with BM25, as Electron's `tools/help-docs.ts`. The index is
//! built on the first help call, so the guide stays out of startup.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, OnceLock};

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::arg;
use crate::agent::mcp::{ToolError, ToolErrorCode};

const PAGES_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/help_pages.json"));
const SNIPPET_UNITS: usize = 240;
const TITLE_WEIGHT: u32 = 3;
const SEARCH_LIMIT: usize = 5;
const STOP_WORDS: &str = "a an and are can do does for how i in is it me my of on or the this to what when where with you your";

static FRONTMATTER: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)\A---\n.*?\n---\n"));
static COMMENT: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)<!--.*?-->"));
static FENCE_DIRECTIVE: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^:::.*$"));
static KBD: LazyLock<Regex> = LazyLock::new(|| re(r"</?kbd>"));
static BLANK_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"\n{3,}"));
static TITLE: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^# (.+)$"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| re(r"^(#{2,3}) (.+)$"));
static TOKEN: LazyLock<Regex> = LazyLock::new(|| re(r"[\p{L}\p{N}]+"));
static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("help regex")
}

struct Section {
    /// Page path without extension, as `user-guide/notes/properties-tags`.
    page: String,
    page_title: String,
    /// The `##` or `###` heading; `None` for the text above the first one.
    section: Option<String>,
    level: usize,
    text: String,
    terms: HashMap<String, u32>,
    length: u32,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct HelpHit {
    pub page: String,
    pub page_title: String,
    pub section: Option<String>,
    pub snippet: String,
}

fn clean(markdown: &str) -> String {
    let text = FRONTMATTER.replace(markdown, "");
    let text = COMMENT.replace_all(&text, "");
    let text = FENCE_DIRECTIVE.replace_all(&text, "");
    let text = KBD.replace_all(&text, "");
    BLANK_RUN.replace_all(&text, "\n\n").trim().to_owned()
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The first `units` UTF-16 units of `text`, as JavaScript's `slice`; a pair it would split is
/// left out whole.
fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, ch) in text.char_indices() {
        used += ch.len_utf16();
        if used > units {
            return &text[..at];
        }
    }
    text
}

fn tokens(text: &str) -> Vec<String> {
    let stop: HashSet<&str> = STOP_WORDS.split(' ').collect();
    TOKEN
        .find_iter(&text.to_lowercase())
        .map(|token| token.as_str().to_owned())
        .filter(|token| !stop.contains(token.as_str()))
        .map(|mut token| {
            if utf16_len(&token) > 3 && token.ends_with('s') && !token.ends_with("ss") {
                token.pop();
            }
            token
        })
        .collect()
}

fn split_page(page: &str, markdown: &str, out: &mut Vec<Section>) {
    let body = clean(markdown);
    let page_title = TITLE
        .captures(&body)
        .map_or_else(|| page.to_owned(), |caps| caps[1].trim().to_owned());
    let mut section: Option<String> = None;
    let mut level = 1;
    let mut lines: Vec<&str> = Vec::new();
    let mut flush = |section: &Option<String>, level: usize, lines: &[&str]| {
        let text = lines.join("\n").trim().to_owned();
        if !text.is_empty() {
            out.push(Section {
                page: page.to_owned(),
                page_title: page_title.clone(),
                section: section.clone(),
                level,
                text,
                terms: HashMap::new(),
                length: 0,
            });
        }
    };
    let mut in_fence = false;
    for line in body.split('\n') {
        if line.starts_with("```") {
            in_fence = !in_fence;
        }
        let heading = (!in_fence).then(|| HEADING.captures(line)).flatten();
        if let Some(heading) = heading {
            flush(&section, level, &lines);
            level = heading[1].len();
            section = Some(heading[2].trim().to_owned());
            lines.clear();
        } else {
            lines.push(line);
        }
    }
    flush(&section, level, &lines);
}

fn build_index(pages: &[(String, String)]) -> Vec<Section> {
    let mut sections = Vec::new();
    for (page, markdown) in pages {
        split_page(page, markdown, &mut sections);
    }
    for section in &mut sections {
        let mut add = |text: &str, weight: u32| {
            for token in tokens(text) {
                *section.terms.entry(token).or_insert(0) += weight;
            }
        };
        add(&section.text.clone(), 1);
        let title = format!(
            "{} {}",
            section.page_title,
            section.section.as_deref().unwrap_or("")
        );
        add(&title, TITLE_WEIGHT);
        section.length = section.terms.values().sum();
    }
    sections
}

fn index() -> &'static [Section] {
    static INDEX: OnceLock<Vec<Section>> = OnceLock::new();
    INDEX.get_or_init(|| {
        let pages: Vec<(String, String)> =
            serde_json::from_str(PAGES_JSON).expect("build.rs writes the help pages");
        build_index(&pages)
    })
}

/// BM25 over the guide's sections; a page title or heading match counts as several body matches.
fn search_in(sections: &[Section], query: &str, limit: usize) -> Vec<HelpHit> {
    if sections.is_empty() {
        return Vec::new();
    }
    let mut query_terms: Vec<String> = Vec::new();
    for token in tokens(query) {
        if !query_terms.contains(&token) {
            query_terms.push(token);
        }
    }
    let count = sections.len() as f64;
    let avg_length = sections.iter().map(|s| f64::from(s.length)).sum::<f64>() / count;
    let (k1, b) = (1.2, 0.75);
    let idf: Vec<f64> = query_terms
        .iter()
        .map(|term| {
            let df = sections
                .iter()
                .filter(|s| s.terms.contains_key(term))
                .count() as f64;
            (1.0 + (count - df + 0.5) / (df + 0.5)).ln()
        })
        .collect();
    let mut scored: Vec<(&Section, f64)> = sections
        .iter()
        .map(|section| {
            let mut score = 0.0;
            for (term, idf) in query_terms.iter().zip(&idf) {
                let tf = f64::from(section.terms.get(term).copied().unwrap_or(0));
                if tf == 0.0 {
                    continue;
                }
                let norm = 1.0 - b + b * f64::from(section.length) / avg_length;
                score += idf * tf * (k1 + 1.0) / (tf + k1 * norm);
            }
            (section, score)
        })
        .filter(|(_, score)| *score > 0.0)
        .collect();
    scored.sort_by(|x, y| y.1.total_cmp(&x.1));
    scored
        .into_iter()
        .take(limit)
        .map(|(s, _)| HelpHit {
            page: s.page.clone(),
            page_title: s.page_title.clone(),
            section: s.section.clone(),
            snippet: utf16_prefix(&SPACE_RUN.replace_all(&s.text, " "), SNIPPET_UNITS).to_owned(),
        })
        .collect()
}

/// One section of a page with its subsections, or the whole page when no section is named.
fn read_in(sections: &[Section], page: &str, section: Option<&str>) -> Option<Value> {
    let mut matches: Vec<&Section> = sections.iter().filter(|s| s.page == page).collect();
    if let Some(name) = section {
        let start = matches
            .iter()
            .position(|s| s.section.as_deref() == Some(name))?;
        let level = matches[start].level;
        let end = matches
            .iter()
            .enumerate()
            .position(|(i, s)| i > start && s.level <= level)
            .unwrap_or(matches.len());
        matches = matches[start..end].to_vec();
    }
    let first = matches.first()?;
    let text = matches
        .iter()
        .map(|s| match &s.section {
            Some(heading) => format!("{} {heading}\n\n{}", "#".repeat(s.level), s.text),
            None => s.text.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(json!({
        "page": page,
        "page_title": first.page_title,
        "section": section,
        "text": text,
    }))
}

/// `memry_help_search`.
pub fn search(args: &Value) -> Value {
    let results = search_in(index(), arg(args, "query").unwrap_or(""), SEARCH_LIMIT);
    json!({ "results": results })
}

/// `memry_help_read`; a page or section the guide does not have is `NOT_FOUND`.
pub fn read(args: &Value) -> Result<Value, ToolError> {
    let page = arg(args, "page").unwrap_or("");
    let section = arg(args, "section");
    read_in(index(), page, section).ok_or_else(|| {
        let what = match section {
            Some(name) => format!("section \"{name}\" on page"),
            None => "page".to_owned(),
        };
        let mut details = Map::new();
        details.insert("page".into(), json!(page));
        details.insert("section".into(), json!(section));
        ToolError::new(
            ToolErrorCode::NotFound,
            format!(
                "No guide {what} \"{page}\". Use a page and section from a memry_help_search \
                 result."
            ),
        )
        .with_details(details)
    })
}

#[cfg(test)]
#[path = "read_help_tests.rs"]
mod tests;

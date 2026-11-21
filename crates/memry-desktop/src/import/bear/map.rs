//! `packages/importers/src/bear/{parse-info,parse-tags,map-notes,rewrite-links}.ts`: what one
//! textbundle's `info.json` and `text.md` say about its note.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use memry_core::markdown::frontmatter::{is_js_whitespace, js_trim};
use regex::{Captures, Regex};

use crate::web::extract::utils::date::{iso_string, parse_date};
use crate::web::extract::utils::json::JsValue;

/// `ENCLOSED_TAG_RE`: `#[tag name]#`.
static ENCLOSED_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[([^\]\[]+)\]#").expect("valid regex"));
/// The tag run of the line pattern `(?<!\S)#([\p{L}\p{N}/\-_]+)`, anchored after its `#`.
static TAG_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}/_-]+").expect("valid regex"));
/// `ASSET_REF_RE`.
static ASSET_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]\(assets/([^)\]]+)\)").expect("valid regex"));
/// `BEAR_LINK_RE`.
static BEAR_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[[^\]\[]*\]\(bear://x-callback-url/open-note\?([^)\[]*)\)").expect("valid regex")
});

/// `BearInfo`, with the dates as `toISOString()` text.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BearInfo {
    pub unique_identifier: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub archived: bool,
    pub trashed: bool,
}

/// `toDate(value)?.toISOString()`: `new Date(value)` of a string or number, `None` when invalid.
fn to_date(value: Option<&JsValue>) -> Option<String> {
    let ms = match value? {
        JsValue::String(text) => parse_date(text)?,
        JsValue::Number(ms) => *ms,
        _ => return None,
    };
    iso_string(Some(ms)).ok()
}

/// `toBool`: `true`, `1` or `'1'`.
fn to_bool(value: Option<&JsValue>) -> bool {
    match value {
        Some(JsValue::Bool(flag)) => *flag,
        Some(JsValue::Number(n)) => *n == 1.0,
        Some(JsValue::String(text)) => text == "1",
        _ => false,
    }
}

/// `parseInfo`: real exports nest the metadata under `net.shinyfrog.bear`.
pub fn parse_info(raw: &JsValue) -> BearInfo {
    if !matches!(raw, JsValue::Object(_)) {
        return BearInfo::default();
    }
    let info = match raw.get("net.shinyfrog.bear") {
        Some(inner @ JsValue::Object(_)) => inner,
        _ => raw,
    };
    BearInfo {
        unique_identifier: info
            .get("uniqueIdentifier")
            .and_then(JsValue::as_str)
            .map(str::to_owned),
        created: to_date(info.get("creationDate")),
        modified: to_date(info.get("modificationDate")),
        archived: to_bool(info.get("archived")),
        trashed: to_bool(info.get("trashed")),
    }
}

/// JavaScript's `\s+` replaced by `_`.
fn underscore_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `/^#{1,6}\s/` on a line without its leading whitespace.
fn is_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&hashes) && line[hashes..].chars().next().is_some_and(is_js_whitespace)
}

/// `parseTags`: enclosed `#[a b]#` tags as `a_b`, then `#tag` runs after whitespace on every
/// line that is not a heading; unique, in UTF-16 order.
pub fn parse_tags(body: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    for caps in ENCLOSED_TAG.captures_iter(body) {
        let tag = underscore_whitespace(js_trim(&caps[1]));
        if !tag.is_empty() {
            seen.insert(tag);
        }
    }
    for line in body.split('\n') {
        if is_heading(line.trim_start_matches(is_js_whitespace)) {
            continue;
        }
        let mut prev: Option<char> = None;
        for (at, c) in line.char_indices() {
            if c == '#'
                && prev.is_none_or(is_js_whitespace)
                && let Some(run) = TAG_RUN.find(&line[at + 1..])
            {
                seen.insert(run.as_str().to_owned());
            }
            prev = Some(c);
        }
    }
    let mut tags: Vec<String> = seen.into_iter().collect();
    tags.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    tags
}

/// `extractTitle`: the first `# ` heading, else the first non-blank line, else the bundle name.
fn extract_title(md: &str, folder_name: &str) -> String {
    let lines = || md.split('\n').map(js_trim);
    if let Some(heading) = lines().find_map(|line| line.strip_prefix("# ")) {
        return js_trim(heading).to_owned();
    }
    lines()
        .find(|line| !line.is_empty())
        .unwrap_or(folder_name)
        .to_owned()
}

/// `MappedNote` without the body, which is the `text.md` it was mapped from.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedNote {
    pub title: String,
    pub tags: Vec<String>,
    pub folder: &'static str,
    pub created: Option<String>,
    pub modified: Option<String>,
    /// Every `](assets/<ref>)` of the body, as written (percent-encoded), repeats included.
    pub asset_refs: Vec<String>,
}

/// `mapNote`.
pub fn map_note(folder_name: &str, md: &str, info: &BearInfo) -> MappedNote {
    MappedNote {
        title: extract_title(md, folder_name),
        tags: parse_tags(md),
        folder: if info.trashed {
            "Bear/Trash"
        } else if info.archived {
            "Bear/Archived"
        } else {
            "Bear"
        },
        created: info.created.clone(),
        modified: info.modified.clone(),
        asset_refs: ASSET_REF
            .captures_iter(md)
            .map(|caps| caps[1].to_owned())
            .collect(),
    }
}

/// `ID_PARAM_RE` (`/\bid=([^&]+)/`) on a link's query: the first `id=` after a non-word
/// character, with a non-empty value.
fn id_param(query: &str) -> Option<&str> {
    let bytes = query.as_bytes();
    let mut from = 0;
    while let Some(found) = query[from..].find("id=") {
        let at = from + found;
        from = at + 1;
        let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        if at > 0 && word(bytes[at - 1]) {
            continue;
        }
        let value = query[at + 3..].split('&').next().unwrap_or("");
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// `rewriteBearLinks`: a `bear://` link to a note of the export becomes `[[its title]]`.
pub fn rewrite_bear_links(body: &str, id_to_title: &HashMap<String, String>) -> String {
    BEAR_LINK
        .replace_all(body, |caps: &Captures| {
            match id_param(&caps[1]).and_then(|id| id_to_title.get(id)) {
                Some(title) => format!("[[{title}]]"),
                None => caps[0].to_owned(),
            }
        })
        .into_owned()
}

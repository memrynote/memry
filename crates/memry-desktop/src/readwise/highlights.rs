//! `highlights.ts`: one highlight as markdown, the `Highlights` body, and the `last` a section
//! records.

use std::cmp::Ordering;
use std::collections::HashSet;

use chrono_tz::Tz;

use super::text::{
    collapse_whitespace, escape_line, format_day, heading_level, inline_tags, js_number, parse_ms,
};
use super::types::{ReadwiseHighlight, SavedImages};
use super::{PlanError, step};
use crate::web::extract::utils::date::iso_string;
use crate::web::extract::utils::js::{is_js_whitespace, trim as js_trim};

pub const EPOCH: &str = "1970-01-01T00:00:00.000Z";

/// `highlightUrl`, which writes `readwise_url` raw into a `[label](url)` link. Here a URL
/// that could end the link or the line (not `http(s)://`, or holding whitespace, `<`, `>`, `(`
/// or `)`) falls back to the highlight's own Readwise link (module docs, Departures).
pub fn highlight_url(highlight: &ReadwiseHighlight) -> String {
    let safe = |url: &&str| {
        (url.starts_with("https://") || url.starts_with("http://"))
            && !url.contains(|c: char| is_js_whitespace(c) || matches!(c, '<' | '>' | '(' | ')'))
    };
    match highlight.readwise_url.as_deref().filter(safe) {
        Some(url) => url.to_string(),
        None => format!("https://readwise.io/open/{}", highlight.id),
    }
}

/// The ids of the highlights whose Readwise link is in a note (`linkedHighlightIds`), as the
/// JS numbers TypeScript holds them: `Number("<digits>")`, in first-seen order.
#[derive(Debug, Clone, Default)]
pub struct LinkedIds {
    ordered: Vec<f64>,
    bits: HashSet<u64>,
}

impl LinkedIds {
    fn insert(&mut self, id: f64) {
        if self.bits.insert(id.to_bits()) {
            self.ordered.push(id);
        }
    }

    pub fn from_ids(ids: impl IntoIterator<Item = i64>) -> Self {
        let mut linked = Self::default();
        for id in ids {
            linked.insert(id as f64);
        }
        linked
    }

    /// `linkedIds.has(highlight.id)`.
    pub fn contains(&self, id: i64) -> bool {
        step();
        self.bits.contains(&(id as f64).to_bits())
    }

    pub fn ids(&self) -> &[f64] {
        &self.ordered
    }
}

/// `linkedHighlightIds`: `/readwise\.io\/open\/(\d+)/g`.
pub fn linked_highlight_ids(markdown: &str) -> LinkedIds {
    const LINK: &str = "readwise.io/open/";
    let mut linked = LinkedIds::default();
    let mut rest = markdown;
    while let Some(at) = rest.find(LINK) {
        let after = &rest[at + LINK.len()..];
        let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits > 0 {
            // A run of ASCII digits always parses; `Number` rounds it to the nearest double.
            linked.insert(after[..digits].parse::<f64>().unwrap_or(f64::NAN));
        }
        rest = &after[digits..];
    }
    linked
}

/// `isLiveHighlight`.
pub fn is_live_highlight(highlight: &ReadwiseHighlight) -> bool {
    !highlight.is_deleted.unwrap_or(false) && !highlight.is_discard.unwrap_or(false)
}

/// `imageHighlightUrl`: the remote URL of an image highlight (Reader), from
/// `/^!\[[^\]]*\]\(\s*<?([^\s>)]+)>?\s*\)$/` on the trimmed text.
pub fn image_highlight_url(highlight: &ReadwiseHighlight) -> Option<String> {
    let text = js_trim(highlight.text.as_deref().unwrap_or_default());
    let rest = text.strip_prefix("![")?;
    // `[^\]]*\]` stops at the first `]`.
    let rest = &rest[rest.find(']')? + 1..];
    let rest = rest.strip_prefix('(')?.trim_start_matches(is_js_whitespace);
    let target = |rest: &str| -> Option<String> {
        let len = rest
            .find(|c: char| is_js_whitespace(c) || c == '>' || c == ')')
            .unwrap_or(rest.len());
        if len == 0 {
            return None;
        }
        let tail = rest[len..].strip_prefix('>').unwrap_or(&rest[len..]);
        (tail.trim_start_matches(is_js_whitespace) == ")").then(|| rest[..len].to_string())
    };
    // `<?` takes the `<` first, and gives it back to the capture when that fails.
    rest.strip_prefix('<')
        .and_then(target)
        .or_else(|| target(rest))
}

fn location_key(highlight: &ReadwiseHighlight) -> f64 {
    highlight.location.unwrap_or(f64::INFINITY)
}

/// `sortHighlights`: by location (a missing one last), then id, stable.
pub fn sort_highlights(highlights: &mut [&ReadwiseHighlight]) {
    highlights.sort_by(|a, b| {
        let (la, lb) = (location_key(a), location_key(b));
        if la != lb {
            return if la < lb {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        a.id.cmp(&b.id)
    });
}

fn pad2(n: f64) -> String {
    format!("{:0>2}", js_number(n))
}

/// `clock`: `h:mm:ss`, or `m:ss` under an hour, in JS number arithmetic.
fn clock(seconds: f64) -> String {
    let total = seconds.floor().max(0.0);
    let h = (total / 3600.0).floor();
    let m = ((total % 3600.0) / 60.0).floor();
    let s = total % 60.0;
    let mm = if h > 0.0 { pad2(m) } else { js_number(m) };
    let hours = if h > 0.0 {
        format!("{}:", js_number(h))
    } else {
        String::new()
    };
    format!("{hours}{mm}:{}", pad2(s))
}

/// `name.charAt(0).toUpperCase() + name.slice(1)`: a first character outside the BMP is half a
/// surrogate pair to `charAt`, which `toUpperCase` leaves as it is.
fn capitalize(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.len_utf16() == 1 => first.to_uppercase().chain(chars).collect(),
        _ => name.to_string(),
    }
}

fn location_label(highlight: &ReadwiseHighlight) -> String {
    let Some(location) = highlight.location else {
        return "Highlight".into();
    };
    let at = js_number(location);
    match highlight.location_type.as_deref() {
        Some("page") => format!("Page {at}"),
        Some("location") => format!("Location {at}"),
        Some("time_offset") => format!("Time {}", clock(location)),
        Some("order") => format!("Position {at}"),
        Some("offset") => format!("Offset {at}"),
        // TypeScript writes the payload's type raw into the link label. Here it is one line
        // with no `[]()` and escaped as text, so it cannot close the link, start a block, or
        // forge a marker, tag or wiki link (module docs, Departures).
        other => {
            let name = other
                .unwrap_or("location")
                .replace('_', " ")
                .replace(['[', ']', '(', ')'], "");
            escape_line(&format!("{} {at}", capitalize(&collapse_whitespace(&name))))
        }
    }
}

/// `imageTarget`: a path as the target of a markdown image, wrapped when it holds a space or
/// paren.
pub fn image_target(path: &str) -> String {
    if path.contains(|c: char| is_js_whitespace(c) || c == '(' || c == ')') {
        format!("<{path}>")
    } else {
        path.to_string()
    }
}

/// `renderHighlight`: one highlight as markdown lines, or `None` when it renders nothing: an
/// image that is not saved, or a heading with no text.
pub fn render_highlight(
    highlight: &ReadwiseHighlight,
    time_zone: Tz,
    images: &SavedImages,
) -> Option<String> {
    let note = collapse_whitespace(highlight.note.as_deref().unwrap_or_default());
    if let Some(level) = heading_level(highlight) {
        let text = escape_line(&collapse_whitespace(
            highlight.text.as_deref().unwrap_or_default(),
        ));
        if text.is_empty() {
            return None;
        }
        let note = if note.is_empty() {
            String::new()
        } else {
            format!("\n\n- {}", escape_line(&note))
        };
        return Some(format!("{} {text}{note}", "#".repeat(level)));
    }

    let text = match image_highlight_url(highlight) {
        Some(url) => format!("![]({})", image_target(images.get(&url)?)),
        None => escape_line(&collapse_whitespace(
            highlight.text.as_deref().unwrap_or_default(),
        )),
    };
    let when = match highlight.highlighted_at.as_deref() {
        Some(at) if !at.is_empty() => Some(at),
        _ => highlight.created_at.as_deref(),
    };
    let day = format_day(when, time_zone);
    let link = format!(
        "[{}]({})",
        location_label(highlight),
        highlight_url(highlight)
    );
    let place = match day {
        Some(day) => format!("({link}, {day})"),
        None => format!("({link})"),
    };
    let tags = inline_tags(highlight.tags.as_deref())
        .iter()
        .map(|tag| format!("#{tag}"))
        .collect::<Vec<_>>()
        .join(" ");
    let parts: Vec<&str> = [text.as_str(), &place, &tags]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
    let mut out = format!("- {}", parts.join(" "));
    if !note.is_empty() {
        out.push_str(&format!("\n  - {}", escape_line(&note)));
    }
    Some(out)
}

/// What `renderHighlights` returns.
pub struct Rendered<'a> {
    pub markdown: String,
    pub rendered: Vec<&'a ReadwiseHighlight>,
    /// Image highlights whose image is not saved.
    pub missing: Vec<&'a ReadwiseHighlight>,
}

/// `renderHighlights`: the `Highlights` body, list items in a row, a heading set off by blank
/// lines.
pub fn render_highlights<'a>(
    highlights: &[&'a ReadwiseHighlight],
    time_zone: Tz,
    images: &SavedImages,
) -> Rendered<'a> {
    let mut live: Vec<&ReadwiseHighlight> = highlights
        .iter()
        .copied()
        .filter(|h| is_live_highlight(h))
        .collect();
    sort_highlights(&mut live);
    let mut rendered = Vec::new();
    let mut missing = Vec::new();
    let mut markdown = String::new();
    let mut previous_ends_in_list: Option<bool> = None;
    for highlight in live {
        step();
        let Some(block) = render_highlight(highlight, time_zone, images) else {
            if image_highlight_url(highlight).is_some() {
                missing.push(highlight);
            }
            continue;
        };
        rendered.push(highlight);
        let heading = heading_level(highlight).is_some();
        if let Some(ends_in_list) = previous_ends_in_list {
            markdown.push_str(if heading || !ends_in_list {
                "\n\n"
            } else {
                "\n"
            });
        }
        previous_ends_in_list = Some(!heading || block.contains("\n\n- "));
        markdown.push_str(&block);
    }
    Rendered {
        markdown,
        rendered,
        missing,
    }
}

/// `Date.parse(toIsoInstant(h.created_at) ?? '')`.
pub(crate) fn created_ms(highlight: &ReadwiseHighlight) -> Option<f64> {
    parse_ms(highlight.created_at.as_deref())
}

/// `newestCreatedAt`: one millisecond past the newest `created_at` of the highlights a section
/// holds, held back to the oldest image still missing, and never before `floor`.
pub fn newest_created_at(
    handled: &[&ReadwiseHighlight],
    missing: &[&ReadwiseHighlight],
    floor: &str,
) -> Result<String, PlanError> {
    let cap = missing
        .iter()
        .filter_map(|h| created_ms(h))
        .fold(f64::INFINITY, f64::min);
    let mut newest: Option<f64> = None;
    for ms in handled.iter().filter_map(|h| created_ms(h)) {
        if ms <= cap && newest.is_none_or(|n| ms > n) {
            newest = Some(ms);
        }
    }
    let past = newest.map(|n| if n < cap { n + 1.0 } else { n });
    let floor_ms = parse_ms(Some(floor));
    let best = match (past, floor_ms) {
        (_, None) => past,
        (Some(p), Some(f)) if p > f => Some(p),
        (_, Some(f)) => Some(f),
    };
    match best {
        None => Ok(EPOCH.to_string()),
        Some(ms) => iso_string(Some(ms)).map_err(|_| PlanError::InvalidTime),
    }
}

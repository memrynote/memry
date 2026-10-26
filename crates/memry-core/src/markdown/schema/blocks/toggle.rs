//! The toggle block of `blocks/markdown.ts`: `<details data-memry-toggle>`
//! wrapping a `<summary>` and the collapsed body.

use serde::Serialize;

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};
use crate::markdown::shared::markdown_fences::FenceTracker;

pub const TOGGLE_OPEN_LINE: &str = "<details data-memry-toggle>";
pub const TOGGLE_OPEN_LINE_EXPANDED: &str = "<details data-memry-toggle open>";
pub const TOGGLE_CLOSE_LINE: &str = "</details>";

/// The `<` of a declined `<details>` line, while it crosses the parser.
const DETAILS_LT_TOKEN: &str = "MEMRYDLT;";

/// `.` of a JS regex: anything but a line terminator.
fn is_dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `^<details\s+data-memry-toggle(\s+open)?>$`: `Some(open)` for a toggle open
/// tag.
fn match_toggle_open_line(line: &str) -> Option<bool> {
    let rest = line.strip_prefix("<details")?;
    let after_ws = rest.trim_start_matches(is_js_whitespace);
    if after_ws.len() == rest.len() {
        return None;
    }
    let tail = after_ws.strip_prefix("data-memry-toggle")?;
    if tail == ">" {
        return Some(false);
    }
    let after_open_ws = tail.trim_start_matches(is_js_whitespace);
    (after_open_ws.len() < tail.len() && after_open_ws == "open>").then_some(true)
}

/// `^<details(?:\s[^>]*)?>$`: any `<details>` open tag.
fn is_details_open_line(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("<details") else {
        return false;
    };
    match rest.strip_suffix('>') {
        Some("") => true,
        Some(attributes) => attributes.starts_with(is_js_whitespace) && !attributes.contains('>'),
        None => false,
    }
}

/// `^<summary>(.*)<\/summary>$`: the summary text, `.` stopping at terminators.
fn match_summary_line(line: &str) -> Option<&str> {
    let inner = line.strip_prefix("<summary>")?.strip_suffix("</summary>")?;
    inner.chars().all(is_dot).then_some(inner)
}

/// `DETAILS_MARKUP_LINE_REGEX`: the three whole-line shapes `<details>` markup
/// takes on disk, matched against the raw line.
fn is_details_markup_line(line: &str) -> bool {
    is_details_open_line(line) || match_summary_line(line).is_some() || line == TOGGLE_CLOSE_LINE
}

/// `escapeDetailsMarkup`: hide the `<` of a `<details>` markup line that no
/// toggle claimed, so the parser reads the line as text.
fn escape_details_markup(line: &str) -> String {
    if is_details_markup_line(line) {
        line.replace('<', DETAILS_LT_TOKEN)
    } else {
        line.to_owned()
    }
}

/// `restoreDetailsMarkup`: put back every `<` that `escapeDetailsMarkup` hid.
pub fn restore_details_markup(text: &str) -> String {
    text.replace(DETAILS_LT_TOKEN, "<")
}

/// `serializeToggleBlock`.
pub fn serialize_toggle_block(
    summary_markdown: &str,
    body_markdown: &str,
    colors_marker: Option<&str>,
    open: bool,
) -> String {
    let summary = summary_markdown
        .split('\n')
        .map(js_trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let body = js_trim(body_markdown);

    let mut lines = vec![
        (if open {
            TOGGLE_OPEN_LINE_EXPANDED
        } else {
            TOGGLE_OPEN_LINE
        })
        .to_owned(),
        format!("<summary>{summary}</summary>"),
    ];
    if !body.is_empty() {
        lines.push(String::new());
        lines.push(body.to_owned());
        lines.push(String::new());
    }
    lines.push(TOGGLE_CLOSE_LINE.to_owned());

    let block = lines.join("\n");
    match colors_marker {
        Some(marker) if !marker.is_empty() => format!("{marker}\n{block}"),
        _ => block,
    }
}

/// A segment of markdown split at its toggles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToggleContentSegment {
    #[serde(rename_all = "camelCase")]
    Toggle {
        /// Inline markdown of the toggle's own line.
        summary: String,
        /// Markdown of the blocks nested under it; `""` for an empty toggle.
        body: String,
        /// Whether the open tag carried `open`.
        open: bool,
        /// A `<!-- colors:{…} -->` line that preceded the block, verbatim.
        colors_marker: Option<String>,
    },
    Markdown {
        text: String,
    },
    /// Blank lines at the seam beyond the single one separating two blocks.
    #[serde(rename_all = "camelCase")]
    Gap {
        extra_lines: usize,
    },
}

/// `BLOCK_COLORS_LINE_REGEX`, `^<!-- colors:(\{[^}]*\}) -->$`. The owner of the
/// regex is `shared::block_colors`; the splitter only needs the predicate.
fn is_block_colors_line(line: &str) -> bool {
    line.strip_prefix("<!-- colors:{")
        .and_then(|rest| rest.strip_suffix("} -->"))
        .is_some_and(|inner| !inner.contains('}'))
}

/// The blank-line bookkeeping `splitMarkdownByToggles` and
/// `splitMarkdownByColumnRegions` share: a gap before the first segment is
/// dropped, a gap of one blank line is the plain separator.
pub(crate) fn push_gap<S>(segments: &mut Vec<S>, blank_lines: usize, gap: impl FnOnce(usize) -> S) {
    if !segments.is_empty() && blank_lines > 1 {
        segments.push(gap(blank_lines - 1));
    }
}

/// The blank-line span at each end of `buffer` and the trimmed text between.
pub(crate) struct TrimmedBuffer {
    pub first: usize,
    pub after_last: usize,
    pub text: String,
}

pub(crate) fn trim_buffer(buffer: &[String]) -> TrimmedBuffer {
    let mut first = 0;
    while first < buffer.len() && js_trim(&buffer[first]).is_empty() {
        first += 1;
    }
    let mut after_last = buffer.len();
    while after_last > first && js_trim(&buffer[after_last - 1]).is_empty() {
        after_last -= 1;
    }
    let text = js_trim(&buffer[first..after_last].join("\n")).to_owned();
    TrimmedBuffer {
        first,
        after_last,
        text,
    }
}

struct ToggleRegion {
    summary: String,
    body: String,
    open: bool,
    end_index: usize,
}

fn read_toggle_region(lines: &[String], open_index: usize, open: bool) -> Option<ToggleRegion> {
    let summary = match_summary_line(js_trim(lines.get(open_index + 1)?))?;
    let mut fence = FenceTracker::new();
    let mut body: Vec<&str> = Vec::new();
    let mut depth = 1usize;

    for (i, line) in lines.iter().enumerate().skip(open_index + 2) {
        if !fence.consume(line) {
            let trimmed = js_trim(line);
            if is_details_open_line(trimmed) {
                depth += 1;
            } else if trimmed == TOGGLE_CLOSE_LINE {
                depth -= 1;
                if depth == 0 {
                    return Some(ToggleRegion {
                        summary: js_trim(summary).to_owned(),
                        body: js_trim(&body.join("\n")).to_owned(),
                        open,
                        end_index: i,
                    });
                }
            }
        }
        body.push(line);
    }
    None
}

/// `splitMarkdownByToggles`: markdown split into toggle regions and everything
/// between them. An unterminated toggle stays markdown, its `<details>` lines
/// escaped.
pub fn split_markdown_by_toggles(markdown: &str) -> Vec<ToggleContentSegment> {
    let lines: Vec<String> = markdown.split('\n').map(str::to_owned).collect();
    let mut segments: Vec<ToggleContentSegment> = Vec::new();
    let mut fence = FenceTracker::new();
    let mut buffer: Vec<String> = Vec::new();

    let gap = |extra_lines| ToggleContentSegment::Gap { extra_lines };
    let flush = |buffer: &mut Vec<String>,
                 segments: &mut Vec<ToggleContentSegment>,
                 pop_colors_marker: bool|
     -> Option<String> {
        let mut marker = None;
        if pop_colors_marker {
            // The trailing blanks are the user's gap against the toggle that
            // follows; only the marker leaves the buffer.
            let mut candidate = buffer.len();
            while candidate > 0 && js_trim(&buffer[candidate - 1]).is_empty() {
                candidate -= 1;
            }
            if candidate > 0 {
                let last = js_trim(&buffer[candidate - 1]);
                if is_block_colors_line(last) {
                    marker = Some(last.to_owned());
                    buffer.remove(candidate - 1);
                }
            }
        }
        let trimmed = trim_buffer(buffer);
        if trimmed.text.is_empty() {
            push_gap(segments, buffer.len(), gap);
        } else {
            push_gap(segments, trimmed.first, gap);
            segments.push(ToggleContentSegment::Markdown { text: trimmed.text });
            push_gap(segments, buffer.len() - trimmed.after_last, gap);
        }
        buffer.clear();
        marker
    };

    let mut i = 0;
    while i < lines.len() {
        let inside_fence = fence.consume(&lines[i]);
        let open = if inside_fence {
            None
        } else {
            match_toggle_open_line(js_trim(&lines[i]))
        };
        let region = open.and_then(|open| read_toggle_region(&lines, i, open));

        let Some(region) = region else {
            buffer.push(if inside_fence {
                lines[i].clone()
            } else {
                escape_details_markup(&lines[i])
            });
            i += 1;
            continue;
        };

        let colors_marker = flush(&mut buffer, &mut segments, true);
        segments.push(ToggleContentSegment::Toggle {
            summary: region.summary,
            body: region.body,
            open: region.open,
            colors_marker,
        });
        i = region.end_index + 1;
    }

    flush(&mut buffer, &mut segments, false);
    segments
}

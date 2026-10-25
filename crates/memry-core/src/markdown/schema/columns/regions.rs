//! Splitting markdown into column regions: the MCM spellings and Pandoc divs.

use serde::Serialize;

use super::settings::{SETTINGS_FENCE_CLOSE, SETTINGS_FENCE_OPEN};
use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};
use crate::markdown::schema::blocks::toggle::{push_gap, trim_buffer};
use crate::markdown::shared::markdown_fences::FenceTracker;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ColumnContentSegment {
    #[serde(rename_all = "camelCase")]
    Columns {
        /// The region's MCM id, `""` when the file gave none.
        region_id: String,
        /// The settings fence, verbatim and fences included, or `""` for none.
        settings: String,
        /// Each column's markdown, trimmed of the blank lines at its edges.
        columns: Vec<String>,
    },
    Markdown {
        text: String,
    },
    /// Blank lines beyond the one separator, as in `ToggleContentSegment`.
    #[serde(rename_all = "camelCase")]
    Gap {
        extra_lines: usize,
    },
}

struct ColumnRegion {
    region_id: String,
    settings: String,
    columns: Vec<String>,
    end_index: usize,
}

fn is_dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Strip an ASCII-case-insensitive prefix (the `i` flag, without `u`, folds
/// only ASCII letters here).
fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

fn strip_one_of<'a>(text: &'a str, names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|name| strip_prefix_ci(text, name))
}

fn trim_js_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

fn strip_dashes(text: &str) -> Option<&str> {
    text.strip_prefix("---")
        .or_else(|| text.strip_prefix("==="))
}

/// `^(?:---|===)\s*(?:start-multi-column|multi-column-start)\s*(?::(.*))?$` (i):
/// `Some(id)` for a start line, the id being the text after the colon.
fn match_mcm_start(line: &str) -> Option<Option<&str>> {
    let rest = trim_js_start(strip_dashes(line)?);
    let rest = trim_js_start(strip_one_of(
        rest,
        &["start-multi-column", "multi-column-start"],
    )?);
    if rest.is_empty() {
        return Some(None);
    }
    let id = rest.strip_prefix(':')?;
    id.chars().all(is_dot).then_some(Some(id))
}

/// `^(?:---|===)\s*(?:column-end|end-column|column-break|break-column)\s*(?:---|===)?$` (i)
fn is_mcm_break(line: &str) -> bool {
    let Some(rest) = strip_dashes(line) else {
        return false;
    };
    let names = ["column-end", "end-column", "column-break", "break-column"];
    let Some(rest) = strip_one_of(trim_js_start(rest), &names) else {
        return false;
    };
    let rest = trim_js_start(rest);
    rest.is_empty() || matches!(rest, "---" | "===")
}

/// `^(?:---|===)\s*(?:end-multi-column|multi-column-end)$` (i)
fn is_mcm_end(line: &str) -> bool {
    strip_dashes(line)
        .and_then(|rest| {
            strip_one_of(
                trim_js_start(rest),
                &["end-multi-column", "multi-column-end"],
            )
        })
        .is_some_and(str::is_empty)
}

/// `^```\s*(?:column-settings|multi-column-settings|settings)\s*$` (i)
fn is_settings_open(line: &str) -> bool {
    line.strip_prefix("```")
        .and_then(|rest| {
            strip_one_of(
                trim_js_start(rest),
                &["column-settings", "multi-column-settings", "settings"],
            )
        })
        .is_some_and(|rest| trim_js_start(rest).is_empty())
}

/// `^```\s*$`
fn is_settings_close(line: &str) -> bool {
    line.strip_prefix("```")
        .is_some_and(|rest| trim_js_start(rest).is_empty())
}

/// `pandocFence`: the descriptor after a `:::` fence (`""` for a bare closing
/// fence), or `None` when the line is not one.
fn pandoc_fence(line: &str) -> Option<&str> {
    let colons = line.bytes().take_while(|b| *b == b':').count();
    (colons >= 3).then(|| js_trim(&line[colons..]))
}

/// `^(?:columns|(?:two|three|four|five|six|seven|eight|nine|ten)-?columns)$` (i)
fn is_pandoc_columns_class(name: &str) -> bool {
    if name.eq_ignore_ascii_case("columns") {
        return true;
    }
    let counts = [
        "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    ];
    counts.iter().any(|count| {
        strip_prefix_ci(name, count).is_some_and(|rest| {
            let rest = rest.strip_prefix('-').unwrap_or(rest);
            rest.eq_ignore_ascii_case("columns")
        })
    })
}

/// `^\{?\s*\.?columnbreak\s*\}?$` (i)
fn is_pandoc_column_break(descriptor: &str) -> bool {
    let rest = descriptor.strip_prefix('{').unwrap_or(descriptor);
    let rest = trim_js_start(rest);
    let rest = rest.strip_prefix('.').unwrap_or(rest);
    let Some(rest) = strip_prefix_ci(rest, "columnbreak") else {
        return false;
    };
    let rest = trim_js_start(rest);
    rest.is_empty() || rest == "}"
}

struct PandocAttributes {
    region_id: String,
    settings_lines: Vec<String>,
}

/// `parsePandocAttributes`: the attributes of a `:::` opener, or `None` when it
/// is not a columns div.
fn parse_pandoc_attributes(descriptor: &str) -> Option<PandocAttributes> {
    let braced = descriptor
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .filter(|inner| inner.chars().all(is_dot));
    let source = braced.unwrap_or(descriptor);
    let tokens: Vec<&str> = source
        .split(is_js_whitespace)
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() || (braced.is_none() && tokens.len() != 1) {
        return None;
    }

    let mut is_columns = false;
    let mut region_id = String::new();
    let mut settings_lines = Vec::new();

    for token in tokens {
        let class_name = if braced.is_some() {
            token.strip_prefix('.').filter(|name| !name.is_empty())
        } else {
            Some(token)
        };
        if let Some(class_name) = class_name {
            if is_pandoc_columns_class(class_name) {
                is_columns = true;
            }
            continue;
        }
        if let Some(id) = token.strip_prefix('#') {
            region_id = id.to_owned();
            continue;
        }
        let Some((key, raw_value)) = token.split_once('=').filter(|(key, _)| !key.is_empty())
        else {
            continue;
        };
        let value = raw_value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(raw_value);
        match key.to_lowercase().as_str() {
            "id" => region_id = value.to_owned(),
            "columngap" | "column-gap" => settings_lines.push(format!("Column Spacing: {value}")),
            // The count is the number of column breaks plus one.
            "col-count" | "colcount" => {}
            _ => settings_lines.push(format!("{key}: {value}")),
        }
    }

    is_columns.then_some(PandocAttributes {
        region_id,
        settings_lines,
    })
}

fn read_column_region(lines: &[String], start: usize) -> Option<ColumnRegion> {
    // Matched on the raw line: an indented marker belongs to a list item or a
    // code block.
    if let Some(id) = match_mcm_start(&lines[start]) {
        return read_mcm_region(lines, start, js_trim(id.unwrap_or("")));
    }
    let descriptor = pandoc_fence(&lines[start])?;
    let attributes = parse_pandoc_attributes(descriptor)?;
    read_pandoc_region(lines, start, &attributes)
}

fn read_mcm_region(lines: &[String], start: usize, region_id: &str) -> Option<ColumnRegion> {
    let mut i = start + 1;
    let mut settings = String::new();

    if i < lines.len() && is_settings_open(js_trim(&lines[i])) {
        let close = (i + 1..lines.len()).find(|&index| is_settings_close(&lines[index]))?;
        settings = lines[i..=close].join("\n");
        i = close + 1;
    }

    let mut fence = FenceTracker::new();
    let mut columns: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    while i < lines.len() {
        let line = &lines[i];
        if !fence.consume(line) {
            let trimmed = js_trim(line);
            if is_mcm_break(trimmed) {
                columns.push(js_trim(&current.join("\n")).to_owned());
                current.clear();
                i += 1;
                continue;
            }
            if is_mcm_end(trimmed) {
                columns.push(js_trim(&current.join("\n")).to_owned());
                return (columns.len() >= 2).then(|| ColumnRegion {
                    region_id: region_id.to_owned(),
                    settings,
                    columns,
                    end_index: i,
                });
            }
        }
        current.push(line);
        i += 1;
    }
    None
}

#[derive(Clone, Copy)]
enum OpenDiv {
    Break,
    Div,
}

fn read_pandoc_region(
    lines: &[String],
    start: usize,
    attributes: &PandocAttributes,
) -> Option<ColumnRegion> {
    let mut fence = FenceTracker::new();
    let mut columns: Vec<String> = Vec::new();
    let mut open_divs: Vec<OpenDiv> = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    for (i, line) in lines.iter().enumerate().skip(start + 1) {
        let div = if fence.consume(line) {
            None
        } else {
            pandoc_fence(line)
        };

        match div {
            Some("") => match open_divs.pop() {
                None => {
                    columns.push(js_trim(&current.join("\n")).to_owned());
                    if columns.len() < 2 {
                        return None;
                    }
                    let settings = if attributes.settings_lines.is_empty() {
                        String::new()
                    } else {
                        let mut parts = vec![SETTINGS_FENCE_OPEN];
                        parts.extend(attributes.settings_lines.iter().map(String::as_str));
                        parts.push(SETTINGS_FENCE_CLOSE);
                        parts.join("\n")
                    };
                    return Some(ColumnRegion {
                        region_id: attributes.region_id.clone(),
                        settings,
                        columns,
                        end_index: i,
                    });
                }
                Some(OpenDiv::Break) => {
                    columns.push(js_trim(&current.join("\n")).to_owned());
                    current.clear();
                    continue;
                }
                Some(OpenDiv::Div) => {}
            },
            Some(descriptor) => {
                if is_pandoc_column_break(descriptor) {
                    open_divs.push(OpenDiv::Break);
                    continue;
                }
                open_divs.push(OpenDiv::Div);
            }
            None => {}
        }
        current.push(line);
    }
    None
}

/// `splitMarkdownByColumnRegions`: markdown split into column regions and
/// everything between them. A region that is unterminated or holds fewer than
/// two columns stays markdown.
pub fn split_markdown_by_column_regions(markdown: &str) -> Vec<ColumnContentSegment> {
    let lines: Vec<String> = markdown.split('\n').map(str::to_owned).collect();
    let mut segments: Vec<ColumnContentSegment> = Vec::new();
    let mut fence = FenceTracker::new();
    let mut buffer: Vec<String> = Vec::new();
    let gap = |extra_lines| ColumnContentSegment::Gap { extra_lines };

    let flush = |buffer: &mut Vec<String>, segments: &mut Vec<ColumnContentSegment>| {
        let trimmed = trim_buffer(buffer);
        if trimmed.text.is_empty() {
            push_gap(segments, buffer.len(), gap);
        } else {
            push_gap(segments, trimmed.first, gap);
            segments.push(ColumnContentSegment::Markdown { text: trimmed.text });
            push_gap(segments, buffer.len() - trimmed.after_last, gap);
        }
        buffer.clear();
    };

    let mut i = 0;
    while i < lines.len() {
        let inside_fence = fence.consume(&lines[i]);
        let region = if inside_fence {
            None
        } else {
            read_column_region(&lines, i)
        };
        let Some(region) = region else {
            buffer.push(lines[i].clone());
            i += 1;
            continue;
        };
        flush(&mut buffer, &mut segments);
        segments.push(ColumnContentSegment::Columns {
            region_id: region.region_id,
            settings: region.settings,
            columns: region.columns,
        });
        i = region.end_index + 1;
    }
    flush(&mut buffer, &mut segments);
    segments
}

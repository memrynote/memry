//! `splitMarkdownByToggles` (`editor-schema/src/blocks/markdown.ts`): the
//! toggles Memry writes (`<details data-memry-toggle>`, a `<summary>` line,
//! the body, `</details>`), the markdown between them, and the blank lines at
//! their seams. Any other `<details>` markup line stays the author's text.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::Unsupported;

/// The `<` of a `<details>` markup line no toggle claimed, while it crosses
/// the parser (`DETAILS_LT_TOKEN`). Restored in every text run.
pub(super) const DETAILS_LT_TOKEN: &str = "MEMRYDLT;";

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Segment {
    Toggle {
        summary: String,
        body: String,
        open: bool,
    },
    Markdown(String),
    /// Empty paragraphs: blank lines beyond the one a block break takes.
    Gap(usize),
}

pub(super) fn split_by_toggles(markdown: &str) -> Result<Vec<Segment>, Unsupported> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut segments = Vec::new();
    let mut fence = super::markers::FenceTracker::default();
    let mut buffer: Vec<String> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let inside_fence = fence.consume(line);
        let region = (!inside_fence)
            .then(|| open_line(js_trim(line)))
            .flatten()
            .and_then(|open| toggle_region(&lines, index, open));
        let Some((toggle, end)) = region else {
            buffer.push(if inside_fence {
                line.to_owned()
            } else {
                escape_details_markup(line)
            });
            index += 1;
            continue;
        };
        if last_non_blank(&buffer).is_some_and(|line| js_trim(line).starts_with("<!-- colors:")) {
            // The colours marker above a toggle is its props, which the seed
            // does not build.
            return Err(Unsupported("coloured toggle"));
        }
        flush(&mut buffer, &mut segments);
        segments.push(toggle);
        index = end + 1;
    }
    flush(&mut buffer, &mut segments);
    Ok(segments)
}

fn last_non_blank(buffer: &[String]) -> Option<&String> {
    buffer.iter().rev().find(|line| !js_trim(line).is_empty())
}

/// `pushGap`: a gap before the first segment is dropped.
fn push_gap(segments: &mut Vec<Segment>, blank_lines: usize) {
    if !segments.is_empty() && blank_lines > 1 {
        segments.push(Segment::Gap(blank_lines - 1));
    }
}

/// `flushMarkdown`.
fn flush(buffer: &mut Vec<String>, segments: &mut Vec<Segment>) {
    let blank = |line: &String| js_trim(line).is_empty();
    let first = buffer.iter().take_while(|line| blank(line)).count();
    let after_last = buffer.len()
        - buffer[first..]
            .iter()
            .rev()
            .take_while(|line| blank(line))
            .count();
    let text = js_trim(&buffer[first..after_last].join("\n")).to_owned();
    if text.is_empty() {
        push_gap(segments, buffer.len());
    } else {
        push_gap(segments, first);
        segments.push(Segment::Markdown(text));
        push_gap(segments, buffer.len() - after_last);
    }
    buffer.clear();
}

/// `TOGGLE_OPEN_LINE_REGEX`, `/^<details\s+data-memry-toggle(\s+open)?>$/`:
/// whether the toggle is open.
fn open_line(line: &str) -> Option<bool> {
    let rest = line.strip_prefix("<details")?;
    let rest = rest.trim_start_matches(is_js_whitespace);
    if rest.len() == line.len() - "<details".len() {
        return None;
    }
    let rest = rest.strip_prefix("data-memry-toggle")?.strip_suffix('>')?;
    if rest.is_empty() {
        return Some(false);
    }
    let attribute = rest.trim_start_matches(is_js_whitespace);
    (attribute.len() < rest.len() && attribute == "open").then_some(true)
}

/// `TOGGLE_SUMMARY_LINE_REGEX`, `/^<summary>(.*)<\/summary>$/`.
fn summary_line(line: &str) -> Option<&str> {
    line.strip_prefix("<summary>")?.strip_suffix("</summary>")
}

/// `DETAILS_OPEN_LINE_REGEX`, `/^<details(?:\s[^>]*)?>$/`.
fn details_open_line(line: &str) -> bool {
    let Some(rest) = line
        .strip_prefix("<details")
        .and_then(|rest| rest.strip_suffix('>'))
    else {
        return false;
    };
    rest.is_empty() || (rest.starts_with(is_js_whitespace) && !rest.contains('>'))
}

/// `readToggleRegion`: the toggle and the index of its `</details>` line.
fn toggle_region(lines: &[&str], open_index: usize, open: bool) -> Option<(Segment, usize)> {
    let summary = summary_line(js_trim(lines.get(open_index + 1)?))?;
    let mut fence = super::markers::FenceTracker::default();
    let mut depth = 1;
    for (index, line) in lines.iter().enumerate().skip(open_index + 2) {
        if !fence.consume(line) {
            let trimmed = js_trim(line);
            if details_open_line(trimmed) {
                depth += 1;
            } else if trimmed == "</details>" {
                depth -= 1;
                if depth == 0 {
                    let body = lines[open_index + 2..index].join("\n");
                    let toggle = Segment::Toggle {
                        summary: js_trim(summary).to_owned(),
                        body: js_trim(&body).to_owned(),
                        open,
                    };
                    return Some((toggle, index));
                }
            }
        }
    }
    None
}

/// `escapeDetailsMarkup`: a `<details>`, `<summary>…</summary>` or
/// `</details>` line has every `<` hidden, so it parses as text.
fn escape_details_markup(line: &str) -> String {
    let markup = details_open_line(line) || summary_line(line).is_some() || line == "</details>";
    if markup {
        line.replace('<', DETAILS_LT_TOKEN)
    } else {
        line.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_memry_toggle_splits_out_with_its_summary_and_body() {
        let segments = split_by_toggles(
            "intro\n\n<details data-memry-toggle open>\n<summary>More</summary>\n\nbody\n\n</details>",
        )
        .expect("split");
        assert_eq!(
            segments,
            vec![
                Segment::Markdown("intro".to_owned()),
                Segment::Toggle {
                    summary: "More".to_owned(),
                    body: "body".to_owned(),
                    open: true
                }
            ]
        );
    }

    #[test]
    fn a_foreign_details_block_stays_text() {
        let segments =
            split_by_toggles("<details>\n<summary>x</summary>\nbody\n</details>").expect("split");
        assert_eq!(
            segments,
            vec![Segment::Markdown(
                "MEMRYDLT;details>\nMEMRYDLT;summary>xMEMRYDLT;/summary>\nbody\nMEMRYDLT;/details>"
                    .to_owned()
            )]
        );
    }
}

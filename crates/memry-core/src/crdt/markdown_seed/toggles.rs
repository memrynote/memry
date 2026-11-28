//! `splitMarkdownByToggles` (`editor-schema/src/blocks/markdown.ts`): the
//! toggles Memry writes (`<details data-memry-toggle>`, a `<summary>` line,
//! the body, `</details>`), the markdown between them, and the blank lines at
//! their seams. Any other `<details>` markup line stays the author's text.

use std::sync::LazyLock;

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::Unsupported;
use super::comments::encode_html_comments;
use super::mask_word::mask_word;
use super::prepare::fence_line;

/// The `<` of a `<details>` markup line no toggle claimed, while it crosses
/// the parser (`DETAILS_LT_TOKEN`), with the process's mask word. Restored in
/// every string of the blocks ([`super::props::restore_masks`]).
pub(super) fn details_lt_token() -> &'static str {
    static TOKEN: LazyLock<String> = LazyLock::new(|| format!("MEMRYDLT{};", mask_word()));
    &TOKEN
}

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
    let mut closers: Option<Closers> = None;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let inside_fence = fence.consume(line);
        let region = (!inside_fence)
            .then(|| open_line(js_trim(line)))
            .flatten()
            .and_then(|open| {
                let closers = closers.get_or_insert_with(|| Closers::new(&lines));
                toggle_region(&lines, index, open, closers)
            });
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
fn toggle_region(
    lines: &[&str],
    open_index: usize,
    open: bool,
    closers: &Closers,
) -> Option<(Segment, usize)> {
    let summary = summary_line(js_trim(lines.get(open_index + 1)?))?;
    let index = closers.close_from(open_index + 2)?;
    let body = lines[open_index + 2..index].join("\n");
    let toggle = Segment::Toggle {
        summary: js_trim(summary).to_owned(),
        body: js_trim(&body).to_owned(),
        open,
    };
    Some((toggle, index))
}

/// `readToggleRegion`'s scan, answered for every start at once.
///
/// The scan opens a fresh fence tracker at its first body line, counts a
/// `<details>` line up and a `</details>` line down outside fences, and ends
/// when the count first drops below its start. Read from one line, it follows
/// a fixed path: a line goes to the next, except that a fence opened there
/// skips to the line after its closer. Each line carries the count change it
/// makes, so a start's answer is a walk along the path that every start sharing
/// the path shares too.
struct Closers {
    /// `after_rise[at]`: the first line past `at` on its path where the count
    /// change summed from there to the path's end is one more than it is at `at`.
    /// A start's close is the line before it: the line that raised the sum.
    after_rise: Vec<Option<usize>>,
}

impl Closers {
    fn new(lines: &[&str]) -> Self {
        let count = lines.len();
        // `balance[at]`: the count changes summed from `at` to the path's end.
        let mut balance = vec![0i64; count + 1];
        let mut after_rise: Vec<Option<usize>> = vec![None; count + 1];
        // By fence character, the closers seen so far reading from the end:
        // nearest last, lengths strictly shrinking toward it, so the nearest
        // one long enough is found by a binary search.
        let mut closing: [Vec<(usize, usize)>; 2] = Default::default();
        let which = |fence_char: char| usize::from(fence_char == '~');
        for at in (0..count).rev() {
            let line = lines[at];
            let fence = fence_line(line);
            let opener =
                fence.filter(|(fence_char, _, rest)| *fence_char != '`' || !rest.contains('`'));
            let (next, change) = match opener {
                Some((fence_char, length, _)) => {
                    let stack = &closing[which(fence_char)];
                    let long_enough = stack.partition_point(|&(_, found)| found >= length);
                    let next = long_enough
                        .checked_sub(1)
                        .map_or(count, |top| stack[top].0 + 1);
                    (next, 0)
                }
                None => {
                    let trimmed = js_trim(line);
                    let change = if details_open_line(trimmed) {
                        1
                    } else {
                        -i64::from(trimmed == "</details>")
                    };
                    (at + 1, change)
                }
            };
            balance[at] = change + balance[next];
            after_rise[at] = match balance[next] - balance[at] {
                1 => Some(next),
                0 => after_rise[next],
                _ => after_rise[next].and_then(|level| after_rise[level]),
            };
            if let Some((fence_char, length, rest)) = fence
                && js_trim(rest).is_empty()
            {
                let stack = &mut closing[which(fence_char)];
                while stack.last().is_some_and(|&(_, found)| found <= length) {
                    stack.pop();
                }
                stack.push((at, length));
            }
        }
        Self { after_rise }
    }

    /// The line of the `</details>` that closes a toggle whose body starts at
    /// `from`.
    fn close_from(&self, from: usize) -> Option<usize> {
        self.after_rise[from].map(|past| past - 1)
    }
}

/// `escapeDetailsMarkup`: a `<details>`, `<summary>…</summary>` or
/// `</details>` line has every `<` hidden, so it parses as text.
fn escape_details_markup(line: &str) -> String {
    if summary_line(line).is_some() {
        return encode_html_comments(line).replace('<', details_lt_token());
    }
    if details_open_line(line) || line == "</details>" {
        line.replace('<', details_lt_token())
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
                "<details>\n<summary>x</summary>\nbody\n</details>"
                    .replace('<', details_lt_token())
            )]
        );
    }

    /// `readToggleRegion` as written: a fresh fence tracker and a count, run
    /// from the first body line to the end.
    fn region_by_scan(lines: &[&str], open_index: usize) -> Option<usize> {
        summary_line(js_trim(lines.get(open_index + 1)?))?;
        let mut fence = super::super::markers::FenceTracker::default();
        let mut depth = 1;
        for (index, line) in lines.iter().enumerate().skip(open_index + 2) {
            if !fence.consume(line) {
                let trimmed = js_trim(line);
                if details_open_line(trimmed) {
                    depth += 1;
                } else if trimmed == "</details>" {
                    depth -= 1;
                    if depth == 0 {
                        return Some(index);
                    }
                }
            }
        }
        None
    }

    #[test]
    fn a_toggle_closes_where_a_scan_from_its_summary_closes() {
        let pool = [
            "<details data-memry-toggle>",
            "<summary>s</summary>",
            "<summary>s</summary>",
            "</details>",
            "</details>",
            "<details>",
            "<details class=\"a\">",
            "```",
            "~~~",
            "````",
            "```js",
            "~~~~",
            "``` a`",
            "  </details>",
            "x",
            "",
        ];
        let mut closed = 0;
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        for _ in 0..30_000 {
            let mut lines = vec![pool[0], pool[1]];
            for _ in 0..(seed % 14 + 1) {
                seed = seed
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                lines.push(pool[(seed >> 33) as usize % pool.len()]);
            }
            let closers = Closers::new(&lines);
            for open_index in 0..lines.len() {
                let found = toggle_region(&lines, open_index, false, &closers).map(|(_, end)| end);
                closed += usize::from(found.is_some());
                assert_eq!(
                    found,
                    region_by_scan(&lines, open_index),
                    "{lines:?} at {open_index}"
                );
            }
        }
        assert!(closed > 5_000, "{closed} toggles closed");
    }
}

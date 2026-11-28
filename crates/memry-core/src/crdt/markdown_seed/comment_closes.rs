//! Where a comment left open at the end of its line closes
//! ([`super::comments`]).
//!
//! Each unclosed opener looks down the lines for its close, and a text of
//! many openers that never close (`x <!--` on each line, then a fence) asks
//! for the same answer from every line. The `<!--` answer depends only on
//! the first line with a `-->` and the first line that opens a fence, so
//! both are found once for the whole text.

use super::backtick_runs::{BacktickRuns, next_tick as next_unescaped_tick, opens_fence_line};
use super::comments::{Close, Form, Next, without_cr};
use super::markers::FenceTracker;

pub(super) enum Later {
    At(Close),
    Text,
    None,
}

/// The line numbers `<!--` needs, `NONE` when there is no such line.
struct HtmlLines {
    /// By line: the first line at or after it that holds a `-->`.
    close: Vec<usize>,
    /// By line: the first line at or after it that opens a fence.
    fence: Vec<usize>,
}

const NONE: usize = usize::MAX;

impl HtmlLines {
    fn new(lines: &[&str]) -> Self {
        let mut close = vec![NONE; lines.len() + 1];
        let mut fence = vec![NONE; lines.len() + 1];
        for (at, line) in lines.iter().enumerate().rev() {
            close[at] = if line.contains("-->") {
                at
            } else {
                close[at + 1]
            };
            // Only a line that opens a fence when none is open counts: the
            // search starts outside one.
            fence[at] = if FenceTracker::default().consume(without_cr(line)) {
                at
            } else {
                fence[at + 1]
            };
        }
        Self { close, fence }
    }
}

pub(super) struct LaterCloses<'a> {
    lines: &'a [&'a str],
    html: Option<HtmlLines>,
}

impl<'a> LaterCloses<'a> {
    pub(super) fn new(lines: &'a [&'a str]) -> Self {
        Self { lines, html: None }
    }

    /// The close of a comment left open at the end of line `index`. A `%%`
    /// comment skips fenced blocks and code spans; an inline `<!--` is text
    /// when a fence opens before its close.
    pub(super) fn find(&mut self, index: usize, form: Form, inline: bool) -> Later {
        if form.prose_only {
            return self.after_code(index, form);
        }
        let lines = self.lines;
        let html = self.html.get_or_insert_with(|| HtmlLines::new(lines));
        let (close, fence) = (html.close[index + 1], html.fence[index + 1]);
        if inline && fence != NONE && (close == NONE || fence <= close) {
            return Later::Text;
        }
        if close == NONE {
            return Later::None;
        }
        let at = lines[close].find(form.close).unwrap_or(0);
        Later::At(Close {
            line: close,
            end: at + form.close.len(),
        })
    }

    fn after_code(&self, index: usize, form: Form) -> Later {
        let mut fence = FenceTracker::default();
        for (next, line) in self.lines.iter().enumerate().skip(index + 1) {
            if fence.consume(without_cr(line)) {
                continue;
            }
            if let Some(at) = index_outside_code_spans(line, form.close) {
                return Later::At(Close {
                    line: next,
                    end: at + form.close.len(),
                });
            }
        }
        Later::None
    }
}

fn index_outside_code_spans(line: &str, marker: &str) -> Option<usize> {
    let (mut ticks, mut next_marker, mut next_tick) = (None, Next::default(), Next::default());
    let mut i = 0;
    loop {
        let at = next_marker.at(i, || line[i..].find(marker).map(|found| found + i));
        let tick = next_tick.at(i, || next_unescaped_tick(line, i));
        let (Some(found), Some(tick)) = (at, tick) else {
            return at;
        };
        if found < tick {
            return at;
        }
        let ticks: &BacktickRuns = ticks.get_or_insert_with(|| BacktickRuns::of_bytes(line));
        i = ticks
            .span_at(tick, !opens_fence_line(line, tick))
            .map_or_else(|| ticks.end_of(tick), |(_, end)| end);
    }
}

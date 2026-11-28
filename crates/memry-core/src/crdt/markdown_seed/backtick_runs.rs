//! Where a code span closes, answered from one pass over the text.
//!
//! A code span opens on a run of backticks and closes on the next run of
//! exactly that length (``(?<!`)RUN(?!`)``). Scanned from every opener, a
//! text of runs that no later run matches costs a scan to the end per
//! opener, and so does the retry at each backtick of one long run
//! (`inline::inline_code`). Here the runs are found once, and each query is
//! a binary search.

use std::collections::HashMap;

pub(super) struct BacktickRuns {
    /// The start and length of each maximal run, in order.
    runs: Vec<(usize, usize)>,
    /// The starts of the runs of each length, in order.
    by_length: HashMap<usize, Vec<usize>>,
}

impl BacktickRuns {
    /// The runs of `ticks`, whether each position is a backtick.
    fn new(ticks: impl Iterator<Item = bool>) -> Self {
        let mut runs: Vec<(usize, usize)> = Vec::new();
        let mut open = false;
        for (at, tick) in ticks.enumerate() {
            match (tick, open) {
                (true, true) => {
                    if let Some(run) = runs.last_mut() {
                        run.1 += 1;
                    }
                }
                (true, false) => runs.push((at, 1)),
                (false, _) => {}
            }
            open = tick;
        }
        let mut by_length: HashMap<usize, Vec<usize>> = HashMap::new();
        for (start, length) in &runs {
            by_length.entry(*length).or_default().push(*start);
        }
        Self { runs, by_length }
    }

    /// The runs of `line`, by byte.
    pub(super) fn of_bytes(line: &str) -> Self {
        Self::new(line.bytes().map(|byte| byte == b'`'))
    }

    /// The runs of `line`, by char.
    pub(super) fn of_chars(line: &[char]) -> Self {
        Self::new(line.iter().map(|ch| *ch == '`'))
    }

    /// Where the run that holds the backtick at `at` ends.
    pub(super) fn end_of(&self, at: usize) -> usize {
        let held = self.runs.partition_point(|(start, _)| *start <= at);
        let (start, length) = self.runs[held - 1];
        start + length
    }

    /// The code span that opens in the run holding the backtick at `tick`:
    /// where it starts and ends, or none when the run is text. A run closes on
    /// the next run of exactly its length; with none, the parser retries from
    /// each later backtick of the run against the shorter run left, so
    /// ``a``x b`c`` is `a`, a span `x b`, then `c`. The longest wins. With
    /// `retry` unset the run pairs only with a run of its own length, which is
    /// how the parser reads the run that opens a fence line, whatever its info
    /// string holds ([`opens_fence_line`]).
    pub(super) fn span_at(&self, tick: usize, retry: bool) -> Option<(usize, usize)> {
        let run_end = self.end_of(tick);
        let length = run_end - tick;
        let shortest = if retry { 1 } else { length };
        (shortest..=length).rev().find_map(|width| {
            let close = self.closing(run_end, width)?;
            Some((run_end - width, close + width))
        })
    }

    /// The start of the first run of exactly `length` backticks that begins
    /// at or after `from`, the end of the run that opens the span.
    pub(super) fn closing(&self, from: usize, length: usize) -> Option<usize> {
        let starts = self.by_length.get(&length)?;
        starts
            .get(starts.partition_point(|start| *start < from))
            .copied()
    }
}

/// Whether the backtick at `tick` starts a run of three or more that opens the
/// line, a fence's, up to three spaces in.
pub(super) fn opens_fence_line(line: &str, tick: usize) -> bool {
    tick <= 3
        && line[..tick].bytes().all(|byte| byte == b' ')
        && line[tick..]
            .bytes()
            .take_while(|byte| *byte == b'`')
            .count()
            >= 3
}

/// Whether an odd run of backslashes comes right before byte `at`.
pub(super) fn is_escaped(line: &str, at: usize) -> bool {
    line.as_bytes()[..at]
        .iter()
        .rev()
        .take_while(|b| **b == b'\\')
        .count()
        % 2
        == 1
}

/// The first backtick at or after `from` that no backslash escapes.
pub(super) fn next_tick(line: &str, from: usize) -> Option<usize> {
    let mut at = from + line[from..].find('`')?;
    while is_escaped(line, at) {
        at += 1 + line[at + 1..].find('`')?;
    }
    Some(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_span_closes_on_the_next_run_of_its_length() {
        // Runs: 0, 2, 4..6, 7..9, 10..13, 14..16, 17.
        let runs = BacktickRuns::of_bytes("`a` ``b`` ```c`` ` d");
        assert_eq!(runs.closing(1, 1), Some(2));
        assert_eq!(runs.closing(6, 2), Some(7));
        assert_eq!(runs.closing(8, 2), Some(14));
        assert_eq!(runs.closing(15, 2), None);
        assert_eq!(runs.closing(13, 3), None);
        assert_eq!(runs.closing(3, 1), Some(17));
        assert_eq!(runs.end_of(5), 6);
        assert_eq!(runs.end_of(10), 13);
        assert_eq!(BacktickRuns::of_chars(&['é', '`', '`']).end_of(2), 3);
    }

    #[test]
    fn a_run_with_no_closer_retries_from_its_later_backticks() {
        let line = "a``x b`c";
        assert_eq!(BacktickRuns::of_bytes(line).span_at(1, true), Some((2, 7)));
        assert_eq!(BacktickRuns::of_bytes("a``x b").span_at(1, true), None);
        assert_eq!(
            BacktickRuns::of_bytes("``a`` `").span_at(0, true),
            Some((0, 5))
        );
    }

    #[test]
    fn an_escaped_backtick_is_no_opener() {
        assert_eq!(next_tick("\\`a`", 0), Some(3));
        assert_eq!(next_tick("\\\\`a", 0), Some(2));
        assert_eq!(next_tick("\\``a", 0), Some(2));
        assert_eq!(next_tick("\\`", 0), None);
    }
}

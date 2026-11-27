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

    /// The start of the first run of exactly `length` backticks that begins
    /// at or after `from`, the end of the run that opens the span.
    pub(super) fn closing(&self, from: usize, length: usize) -> Option<usize> {
        let starts = self.by_length.get(&length)?;
        starts
            .get(starts.partition_point(|start| *start < from))
            .copied()
    }
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
}

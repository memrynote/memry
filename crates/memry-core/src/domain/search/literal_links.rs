//! `[[wiki link]]` syntax left as plain text in a body (#3318).
//!
//! Desktop indexes links from the note's markdown (`extractWikiLinks` in
//! `packages/shared/src/wiki-target.ts`), so `[[Note]]` counts whether its
//! document holds a `wikiLink` node or the literal characters. Synced bodies
//! often hold the characters: a staging vault had 219 literal links and 2
//! nodes, and the core indexed only the nodes. This is the reference's
//! `wikiLinkTargets` scan, run over a block's plain text with code left out,
//! as the reference blanks code before scanning.

use std::cell::Cell;

use crate::crdt::blocks::Block;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Characters this thread's scans looked at, for the complexity tests.
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

fn step() {
    STEPS.with(|steps| steps.set(steps.get() + 1));
}

/// Marks whose run is not prose: code is not a link, and an inline node's
/// text is not the characters a reader typed.
const NOT_PROSE: [&str; 2] = ["code", "inlineImage"];

/// Every literal target in `block`, in document order.
pub(super) fn targets(block: &Block) -> Vec<String> {
    if block.kind == "codeBlock" {
        return Vec::new();
    }
    let mut text: Vec<char> = Vec::new();
    for run in &block.inline {
        let prose = run.target.is_none()
            && !run
                .marks
                .iter()
                .any(|mark| NOT_PROSE.contains(&mark.as_str()));
        if prose {
            text.extend(run.text.chars());
        } else {
            // A break, so `[[` before code and `]]` after it are not one link.
            text.push('\n');
        }
    }
    scan(&text)
}

/// The targets `/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g` captures, as the
/// reference's `wikiLinkTargets` finds them: in linear time, each position's
/// next `]` and next `]`-or-`|` looked up once. Searching forward from every
/// `[[` instead took quadratic time on a run of unclosed `[[`.
fn scan(text: &[char]) -> Vec<String> {
    let length = text.len();
    let mut next_close = vec![length; length + 1];
    let mut next_stop = vec![length; length + 1];
    for at in (0..length).rev() {
        step();
        next_close[at] = if text[at] == ']' {
            at
        } else {
            next_close[at + 1]
        };
        next_stop[at] = if matches!(text[at], ']' | '|') {
            at
        } else {
            next_stop[at + 1]
        };
    }
    let find = |from: usize, next: &[usize]| next[from.min(length)];
    let open_from = |from: usize| {
        (from..length.saturating_sub(1)).find(|&at| {
            step();
            text[at] == '[' && text[at + 1] == '['
        })
    };

    let mut targets = Vec::new();
    let mut open = open_from(0);
    while let Some(at) = open {
        let start = at + 2;
        let stop = find(start, &next_stop);
        let mut end = None;
        if stop > start && stop < text.len() {
            let aliased = text[stop] == '|';
            let close = if aliased {
                find(stop + 1, &next_close)
            } else {
                stop
            };
            if text.get(close + 1) == Some(&']') && (!aliased || close > stop + 1) {
                end = Some(close + 2);
            }
        }
        let Some(end) = end else {
            open = open_from(at + 1);
            continue;
        };
        // A GFM table cell writes the alias pipe `\|`; the backslash is the
        // table's, not the target's.
        let escaped = text[stop] == '|' && text[stop - 1] == '\\';
        targets.push(
            text[start..if escaped { stop - 1 } else { stop }]
                .iter()
                .collect(),
        );
        open = open_from(end);
    }
    targets
}

#[cfg(test)]
mod tests {
    use super::scan;

    fn targets(text: &str) -> Vec<String> {
        scan(&text.chars().collect::<Vec<_>>())
    }

    #[test]
    fn matches_the_reference_grammar() {
        assert_eq!(targets("See [[A]] and [[B|shown]]."), ["A", "B"]);
        assert_eq!(targets("[[A#Heading]] [[ ]]"), ["A#Heading", " "]);
        assert_eq!(targets("[[]] [[A|]] [[open"), Vec::<String>::new());
        assert_eq!(targets("[[[A]]"), ["[A"]);
        assert_eq!(targets(r"| [[A\|b]] |"), ["A"]);
    }
}

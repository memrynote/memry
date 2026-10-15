//! `[[wiki link]]` syntax left as plain text in a body (#3318).
//!
//! Desktop indexes links from the note's markdown (`extractWikiLinks` in
//! `packages/shared/src/wiki-target.ts`), so `[[Note]]` counts whether its
//! document holds a `wikiLink` node or the literal characters. Synced bodies
//! often hold the characters: a staging vault had 219 literal links and 2
//! nodes, and the core indexed only the nodes. This is the reference's
//! `wikiLinkTargets` scan, run over a block's plain text with code left out,
//! as the reference blanks code before scanning.

use crate::crdt::blocks::Block;

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
/// reference's `wikiLinkTargets` finds them.
fn scan(text: &[char]) -> Vec<String> {
    let find = |from: usize, wanted: &dyn Fn(char) -> bool| {
        (from..text.len())
            .find(|&at| wanted(text[at]))
            .unwrap_or(text.len())
    };
    let open_from = |from: usize| {
        (from..text.len().saturating_sub(1)).find(|&at| text[at] == '[' && text[at + 1] == '[')
    };

    let mut targets = Vec::new();
    let mut open = open_from(0);
    while let Some(at) = open {
        let start = at + 2;
        let stop = find(start, &|c| c == ']' || c == '|');
        let mut end = None;
        if stop > start && stop < text.len() {
            let aliased = text[stop] == '|';
            let close = if aliased {
                find(stop + 1, &|c| c == ']')
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

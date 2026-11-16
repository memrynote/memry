//! The character diff behind `ReplaceText`: which spans of a block's flattened
//! text change, with each inline node (U+FFFC) as an anchor no span crosses
//! unless the user removed that node.

use std::ops::Range;

use super::text::INLINE_NODE_PLACEHOLDER;

/// The span `from` and `to` differ in, by common prefix and suffix: the start,
/// the end of the span in `from`, and the end of the span in `to`.
pub(super) fn changed_span(from: &[char], to: &[char]) -> (usize, usize, usize) {
    let prefix = from
        .iter()
        .zip(to.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = from[prefix..]
        .iter()
        .rev()
        .zip(to[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    (prefix, from.len() - suffix, to.len() - suffix)
}

/// The spans that turn `current` into `wanted`, front to back: each pairs a
/// range of `current` to replace with a range of `wanted`.
///
/// One prefix-and-suffix span would cover every node between the first and
/// the last change, and deleting the span deletes those nodes even when the
/// user kept them: `a￼b￼c` to `ab￼cX` is one span `￼b￼c` to `b￼cX`, and a
/// node is never rebuilt from a placeholder, so chip B was lost. Instead the
/// changed middle is split at the nodes both texts keep, and each gap between
/// two kept nodes is its own prefix-and-suffix span. A block without nodes is
/// one span, as before.
pub(super) fn changed_spans(
    current: &[char],
    wanted: &[char],
) -> Vec<(Range<usize>, Range<usize>)> {
    let (start, current_end, wanted_end) = changed_span(current, wanted);
    let kept = kept_nodes(&current[start..current_end], &wanted[start..wanted_end]);
    let mut spans = Vec::new();
    let (mut from_current, mut from_wanted) = (start, start);
    let boundaries = kept
        .into_iter()
        .map(|(at_current, at_wanted)| (start + at_current, start + at_wanted))
        .chain([(current_end, wanted_end)]);
    for (to_current, to_wanted) in boundaries {
        let gap_current = &current[from_current..to_current];
        let gap_wanted = &wanted[from_wanted..to_wanted];
        let (prefix, removed_end, inserted_end) = changed_span(gap_current, gap_wanted);
        if prefix < removed_end || prefix < inserted_end {
            spans.push((
                from_current + prefix..from_current + removed_end,
                from_wanted + prefix..from_wanted + inserted_end,
            ));
        }
        // Past the kept node; the final boundary is the end and is not read.
        (from_current, from_wanted) = (to_current + 1, to_wanted + 1);
    }
    spans
}

/// Above this many table cells the alignment pairs nodes by order instead.
const ALIGNMENT_CELL_LIMIT: usize = 1 << 20;

/// The nodes `current` and `wanted` both keep, as index pairs in order.
fn kept_nodes(current: &[char], wanted: &[char]) -> Vec<(usize, usize)> {
    if !current.iter().any(is_node) || !wanted.iter().any(is_node) {
        return Vec::new();
    }
    common(current, wanted)
        .into_iter()
        .filter(|&(at, _)| is_node(&current[at]))
        .collect()
}

fn is_node(character: &char) -> bool {
    *character == INLINE_NODE_PLACEHOLDER
}

/// The characters `from` and `to` share, as index pairs in order: a longest
/// common subsequence in which one node outweighs every character, so as
/// many nodes are kept as `to` still spells and none is given up to keep a
/// character; the characters then pick which nodes those are. The shell
/// cannot make a node, so `to` never holds more nodes than it saw.
fn common(from: &[char], to: &[char]) -> Vec<(usize, usize)> {
    let (rows, columns) = (from.len(), to.len());
    if (rows + 1).saturating_mul(columns + 1) > ALIGNMENT_CELL_LIMIT {
        // A rewrite this large is a paste, not typing: keep the first nodes
        // in order, so no more nodes are deleted than the shell removed.
        let positions = |text: &[char]| -> Vec<usize> {
            (0..text.len())
                .filter(|&index| is_node(&text[index]))
                .collect()
        };
        return positions(from).into_iter().zip(positions(to)).collect();
    }

    // Bounded by the cell limit: the score fits in u32.
    let node_weight = rows.min(columns) as u32 + 1;
    let weight = |character: &char| if is_node(character) { node_weight } else { 1 };
    let width = columns + 1;
    // best[i * width + j]: the best score aligning from[i..] with to[j..].
    let mut best = vec![0u32; (rows + 1) * width];
    for i in (0..rows).rev() {
        for j in (0..columns).rev() {
            let mut score = best[(i + 1) * width + j].max(best[i * width + j + 1]);
            if from[i] == to[j] {
                score = score.max(weight(&from[i]) + best[(i + 1) * width + j + 1]);
            }
            best[i * width + j] = score;
        }
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < rows && j < columns {
        let here = best[i * width + j];
        if from[i] == to[j] && here == weight(&from[i]) + best[(i + 1) * width + j + 1] {
            pairs.push((i, j));
            (i, j) = (i + 1, j + 1);
        } else if here == best[(i + 1) * width + j] {
            i += 1;
        } else {
            j += 1;
        }
    }
    pairs
}

/// The shell's edit, `base` to `wanted`, replayed on the live block `current`.
///
/// A shell holding unsaved typing does not see a peer's edit that merged in
/// the meantime, so its `wanted` lacks it; diffing `wanted` against the live
/// block would delete it. So this is a three-way merge: each live character
/// is traced to the `base` character it is (`changed_spans`, so a peer's
/// node is never confused with one beside it) or marked the peer's, and the
/// user's own edit, `base` to `wanted` as its smallest set of deletes and
/// inserts, is replayed on those. The peer's text and nodes stay where the
/// peer put them, even inside text the user retyped: `hello world` typed to
/// `Ahello worldB` over a peer's link after `hello ` is `Ahello ￼worldB`.
/// A user's delete removes the base text it covered and never the peer's,
/// and a user's insert at the peer's place lands after the peer's text.
pub(super) fn rebase(base: &[char], current: &[char], wanted: &[char]) -> Vec<char> {
    // The base index each live character is, `None` for the peer's.
    let mut origin: Vec<Option<usize>> = Vec::with_capacity(current.len());
    let mut from_base = 0;
    for (removed, inserted) in changed_spans(base, current) {
        origin.extend((from_base..removed.start).map(Some));
        origin.extend(inserted.map(|_| None));
        from_base = removed.end;
    }
    origin.extend((from_base..base.len()).map(Some));

    // The user's edit: which base characters go, and what goes in before
    // which base index.
    let (start, base_end, wanted_end) = changed_span(base, wanted);
    let kept = common(&base[start..base_end], &wanted[start..wanted_end])
        .into_iter()
        .map(|(at_base, at_wanted)| (start + at_base, start + at_wanted));
    let mut deleted = vec![false; base.len()];
    let mut inserts: Vec<(usize, &[char])> = Vec::new();
    let (mut next_base, mut next_wanted) = (start, start);
    for (at_base, at_wanted) in kept.chain([(base_end, wanted_end)]) {
        deleted[next_base..at_base].fill(true);
        if next_wanted < at_wanted {
            inserts.push((next_base, &wanted[next_wanted..at_wanted]));
        }
        (next_base, next_wanted) = (at_base + 1, at_wanted + 1);
    }

    let mut out = Vec::with_capacity(current.len() + wanted.len());
    let mut inserts = inserts.into_iter().peekable();
    for (character, origin) in current.iter().zip(origin) {
        if let Some(at) = origin {
            while let Some((_, text)) = inserts.next_if(|(before, _)| *before <= at) {
                out.extend_from_slice(text);
            }
            if deleted[at] {
                continue;
            }
        }
        out.push(*character);
    }
    for (_, text) in inserts {
        out.extend_from_slice(text);
    }
    out
}

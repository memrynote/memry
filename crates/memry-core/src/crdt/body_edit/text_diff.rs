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
///
/// A longest common subsequence in which one node outweighs every character,
/// so as many nodes are kept as `wanted` still spells and none is deleted to
/// save a character; the characters then pick which nodes those are. The
/// shell cannot make a node, so `wanted` never holds more nodes than it saw.
fn kept_nodes(current: &[char], wanted: &[char]) -> Vec<(usize, usize)> {
    let is_node = |character: &char| *character == INLINE_NODE_PLACEHOLDER;
    if !current.iter().any(is_node) || !wanted.iter().any(is_node) {
        return Vec::new();
    }
    let (rows, columns) = (current.len(), wanted.len());
    if (rows + 1).saturating_mul(columns + 1) > ALIGNMENT_CELL_LIMIT {
        // A rewrite this large is a paste, not typing: keep the first nodes
        // in order, so no more nodes are deleted than the shell removed.
        let positions = |text: &[char]| -> Vec<usize> {
            (0..text.len())
                .filter(|&index| is_node(&text[index]))
                .collect()
        };
        return positions(current)
            .into_iter()
            .zip(positions(wanted))
            .collect();
    }

    // Bounded by the cell limit: the score fits in u32.
    let node_weight = rows.min(columns) as u32 + 1;
    let weight = |character: &char| if is_node(character) { node_weight } else { 1 };
    let width = columns + 1;
    // best[i * width + j]: the best score aligning current[i..] with wanted[j..].
    let mut best = vec![0u32; (rows + 1) * width];
    for i in (0..rows).rev() {
        for j in (0..columns).rev() {
            let mut score = best[(i + 1) * width + j].max(best[i * width + j + 1]);
            if current[i] == wanted[j] {
                score = score.max(weight(&current[i]) + best[(i + 1) * width + j + 1]);
            }
            best[i * width + j] = score;
        }
    }
    let mut kept = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < rows && j < columns {
        let here = best[i * width + j];
        if current[i] == wanted[j] && here == weight(&current[i]) + best[(i + 1) * width + j + 1] {
            if is_node(&current[i]) {
                kept.push((i, j));
            }
            (i, j) = (i + 1, j + 1);
        } else if here == best[(i + 1) * width + j] {
            i += 1;
        } else {
            j += 1;
        }
    }
    kept
}

/// The shell's edit, `base` to `wanted`, replayed on the live block `current`.
///
/// A shell holding unsaved typing does not see a peer's edit that merged in
/// the meantime, so its `wanted` lacks it; diffing `wanted` against the live
/// block would delete it. Instead the peer's span (`base` to `current`) and the
/// user's span (`base` to `wanted`) are both taken against `base`, and the
/// user's span is moved past the peer's. Where the two overlap the peer's new
/// text is kept, as the CRDT merge of the two edits would keep it: the user's
/// delete removes what it covered around the peer's text, never the text.
pub(super) fn rebase(base: &[char], current: &[char], wanted: &[char]) -> Vec<char> {
    let (peer_start, peer_end_base, peer_end_live) = changed_span(base, current);
    let (start, end_base, end_wanted) = changed_span(base, wanted);
    let inserted = &wanted[start..end_wanted];
    // A base position at or after the peer's span, in the live block.
    let shift = |position: usize| position + peer_end_live - peer_end_base;
    let (head, tail) = if end_base <= peer_start {
        (current[..start].to_vec(), end_base)
    } else if start >= peer_end_base {
        (current[..shift(start)].to_vec(), shift(end_base))
    } else {
        // Overlapping: the peer's new text survives, and the user's change
        // lands on whichever side of it the user's span started.
        let tail = shift(end_base).max(peer_end_live);
        if start <= peer_start {
            let mut out = current[..start].to_vec();
            out.extend_from_slice(inserted);
            out.extend_from_slice(&current[peer_start..peer_end_live]);
            out.extend_from_slice(&current[tail..]);
            return out;
        }
        (current[..peer_end_live].to_vec(), tail)
    };
    let mut out = head;
    out.extend_from_slice(inserted);
    out.extend_from_slice(&current[tail..]);
    out
}

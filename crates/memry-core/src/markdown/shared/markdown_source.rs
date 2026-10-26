//! Port of `packages/shared/src/markdown-source.ts` without its Y.Doc channel
//! (that is `convert::roots`): the author's bytes, carried across the round
//! trip (#1915). The current serialization is merged three ways at line
//! granularity (`base` is what the source canonicalizes to, `ours` the
//! canonical text now, `theirs` the source), and the caller proves the merge
//! by re-parsing it.

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};

/// Re-parses markdown through the pipeline that produced `canonical_now`.
/// `None` when the parse fails, which counts as a failed proof.
pub type Canonicalize<'a> = &'a mut dyn FnMut(&str) -> Option<String>;

/// Myers' diff keeps one row of the search per edit-distance step, so its
/// memory is quadratic in the distance; past this the merge is refused.
pub const MAX_EDIT_DISTANCE: usize = 2000;

const RULE_LINE_KEY: &str = "\u{0}rule";

fn trim_trailing_newlines(text: &str) -> &str {
    text.trim_end_matches('\n')
}

/// `restoreMarkdownSource`: the bytes to write for a document that serializes
/// to `canonical_now`, given the `source` it was read from.
pub fn restore_markdown_source(
    canonical_now: &str,
    source: Option<&str>,
    canonicalize: Canonicalize,
) -> String {
    let Some(source) = source else {
        return canonical_now.to_owned();
    };
    let Some(seed_canonical) = canonicalize(source) else {
        return canonical_now.to_owned();
    };
    let ours = trim_trailing_newlines(canonical_now);
    let base = trim_trailing_newlines(&seed_canonical);
    if ours == base {
        return source.to_owned();
    }
    let merged = match merge_markdown_source(source, base, ours) {
        Some(merged) if merged != ours => merged,
        _ => return canonical_now.to_owned(),
    };
    let Some(proof) = canonicalize(&merged) else {
        return canonical_now.to_owned();
    };
    let proven = trim_trailing_newlines(&proof);
    if proven == ours {
        return merged;
    }
    // House style can fail its own re-parse (a trailing space or tab a
    // paragraph ends in is dropped). A merge that reads back as house style
    // would loses nothing house style keeps.
    match canonicalize(canonical_now) {
        Some(ours_proof) if trim_trailing_newlines(&ours_proof) == proven => merged,
        _ => canonical_now.to_owned(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineHunk {
    pub base_start: usize,
    pub base_length: usize,
    pub side_start: usize,
    pub side_length: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Ours,
    Theirs,
}

struct TaggedHunk {
    hunk: LineHunk,
    side: Side,
}

/// What a line looks like with the spellings this module carries erased.
fn markdown_alignment_key(line: &str) -> String {
    let trimmed = js_trim(line);
    let stripped = trimmed.trim_start_matches(|c: char| {
        matches!(c, '#' | '>' | '*' | '+' | '-') || is_js_whitespace(c)
    });
    let mut key = String::with_capacity(stripped.len());
    let mut in_space = false;
    for c in stripped.chars().filter(|c| *c != '_' && *c != '*') {
        if is_js_whitespace(c) {
            if !in_space {
                key.push(' ');
            }
            in_space = true;
        } else {
            key.push(c);
            in_space = false;
        }
    }
    if key.is_empty() && !trimmed.is_empty() {
        RULE_LINE_KEY.to_owned()
    } else {
        key
    }
}

/// `mergeMarkdownSource`: the unproven three-way merge. `None` when a diff
/// exceeds [`MAX_EDIT_DISTANCE`].
pub fn merge_markdown_source(
    source_text: &str,
    base_text: &str,
    canonical_now: &str,
) -> Option<String> {
    let base: Vec<&str> = base_text.split('\n').collect();
    let ours: Vec<&str> = canonical_now.split('\n').collect();
    let theirs: Vec<&str> = source_text.split('\n').collect();

    let ours_hunks = diff_lines(&base, &ours, markdown_alignment_key)?;
    let theirs_hunks = diff_lines(&base, &theirs, markdown_alignment_key)?;
    let mut hunks: Vec<TaggedHunk> = ours_hunks
        .into_iter()
        .map(|hunk| TaggedHunk {
            hunk,
            side: Side::Ours,
        })
        .chain(theirs_hunks.into_iter().map(|hunk| TaggedHunk {
            hunk,
            side: Side::Theirs,
        }))
        .collect();
    hunks.sort_by_key(|tagged| tagged.hunk.base_start);

    let mut out: Vec<&str> = Vec::new();
    let mut base_cursor = 0;
    let mut i = 0;
    while i < hunks.len() {
        let region_start = hunks[i].hunk.base_start;
        let mut region_end = region_start + hunks[i].hunk.base_length;
        let first = i;
        i += 1;
        // Adjacent hunks (no stable base line between them) are one region.
        while i < hunks.len() && hunks[i].hunk.base_start <= region_end {
            region_end = region_end.max(hunks[i].hunk.base_start + hunks[i].hunk.base_length);
            i += 1;
        }
        let region = &hunks[first..i];
        out.extend_from_slice(&base[base_cursor.min(base.len())..region_start.min(base.len())]);
        base_cursor = region_end;

        let ours_text = side_slice(&ours, region, Side::Ours, region_start, region_end);
        let theirs_text = side_slice(&theirs, region, Side::Theirs, region_start, region_end);
        match (ours_text, theirs_text) {
            (None, Some(theirs)) => out.extend(theirs),
            (Some(ours), None) => out.extend(ours),
            (Some(ours), Some(theirs)) => {
                out.extend(if ours == theirs { theirs } else { ours });
            }
            (None, None) => {}
        }
    }
    out.extend_from_slice(&base[base_cursor.min(base.len())..]);
    Some(out.join("\n"))
}

/// `diffLines`: the edit script from `a` to `b` as ascending hunks, minimal
/// over `key`; lines `key` equates but that differ byte for byte become
/// single-line change hunks. `None` past [`MAX_EDIT_DISTANCE`].
pub fn diff_lines(a: &[&str], b: &[&str], key: impl Fn(&str) -> String) -> Option<Vec<LineHunk>> {
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - prefix
        && suffix < b.len() - prefix
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let n = a.len() - prefix - suffix;
    let m = b.len() - prefix - suffix;
    if n == 0 && m == 0 {
        return Some(Vec::new());
    }
    if n == 0 || m == 0 {
        return Some(vec![LineHunk {
            base_start: prefix,
            base_length: n,
            side_start: prefix,
            side_length: m,
        }]);
    }
    let ka: Vec<String> = a.iter().map(|l| key(l)).collect();
    let kb: Vec<String> = b.iter().map(|l| key(l)).collect();
    let aligned = myers_matches(&ka, &kb, prefix, n, m)?;
    let matches: Vec<(usize, usize)> = aligned
        .into_iter()
        .filter(|(ai, bi)| a[*ai] == b[*bi])
        .collect();

    let mut hunks = Vec::new();
    let (mut ai, mut bi) = (prefix, prefix);
    let mut gap_before = |ma: usize, mb: usize, ai: usize, bi: usize| {
        if ma > ai || mb > bi {
            hunks.push(LineHunk {
                base_start: ai,
                base_length: ma - ai,
                side_start: bi,
                side_length: mb - bi,
            });
        }
    };
    for (ma, mb) in matches {
        gap_before(ma, mb, ai, bi);
        ai = ma + 1;
        bi = mb + 1;
    }
    gap_before(prefix + n, prefix + m, ai, bi);
    Some(hunks)
}

/// Matched line pairs `(a index, b index)` ascending, for the middle that the
/// common prefix and suffix leave.
fn myers_matches(
    a: &[String],
    b: &[String],
    offset: usize,
    n: usize,
    m: usize,
) -> Option<Vec<(usize, usize)>> {
    let limit = (n + m).min(MAX_EDIT_DISTANCE);
    let mut v = vec![0i32; 2 * limit + 3];
    // `at(k)` is `k + limit + 1`: the furthest x on diagonal k.
    let at = |k: isize| (k + limit as isize + 1) as usize;
    let mut history: Vec<Vec<i32>> = Vec::new();
    v[at(1)] = 0;
    for d in 0..=limit as isize {
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) {
                v[at(k + 1)]
            } else {
                v[at(k - 1)] + 1
            };
            let mut y = x - k as i32;
            while (x as usize) < n
                && (y as usize) < m
                && a[offset + x as usize] == b[offset + y as usize]
            {
                x += 1;
                y += 1;
            }
            v[at(k)] = x;
            if x as usize >= n && y as usize >= m {
                history.push(v[at(-d)..=at(d)].to_vec());
                return Some(backtrack(&history, d, n, m, offset));
            }
            k += 2;
        }
        history.push(v[at(-d)..=at(d)].to_vec());
    }
    None
}

fn backtrack(
    history: &[Vec<i32>],
    distance: isize,
    n: usize,
    m: usize,
    offset: usize,
) -> Vec<(usize, usize)> {
    let mut matches = Vec::new();
    let (mut x, mut y) = (n as i32, m as i32);
    let mut d = distance;
    while d > 0 {
        let previous = &history[(d - 1) as usize];
        let prev_at = |k: isize| previous[(k + d - 1) as usize];
        let k = (x - y) as isize;
        let prev_k = if k == -d || (k != d && prev_at(k - 1) < prev_at(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = prev_at(prev_k);
        let prev_y = prev_x - prev_k as i32;
        let snake_start_x = if prev_k == k - 1 { prev_x + 1 } else { prev_x };
        let snake_start_y = snake_start_x - k as i32;
        while x > snake_start_x && y > snake_start_y {
            x -= 1;
            y -= 1;
            matches.push((offset + x as usize, offset + y as usize));
        }
        x = prev_x;
        y = prev_y;
        d -= 1;
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        matches.push((offset + x as usize, offset + y as usize));
    }
    matches.reverse();
    matches
}

/// `Array#slice(start, end)`: negative indices count from the end.
fn js_slice<'a>(lines: &[&'a str], start: i64, end: i64) -> Vec<&'a str> {
    let len = lines.len() as i64;
    let resolve = |i: i64| if i < 0 { (len + i).max(0) } else { i.min(len) };
    let (s, e) = (resolve(start), resolve(end));
    if s >= e {
        Vec::new()
    } else {
        lines[s as usize..e as usize].to_vec()
    }
}

/// One side's lines for a base region, or `None` when that side has no hunk there.
fn side_slice<'a>(
    lines: &[&'a str],
    region: &[TaggedHunk],
    side: Side,
    region_start: usize,
    region_end: usize,
) -> Option<Vec<&'a str>> {
    let own: Vec<&LineHunk> = region
        .iter()
        .filter(|t| t.side == side)
        .map(|t| &t.hunk)
        .collect();
    let (first, last) = (own.first()?, own.last()?);
    let start = first.side_start as i64 - (first.base_start as i64 - region_start as i64);
    let end = (last.side_start + last.side_length) as i64
        + (region_end as i64 - (last.base_start + last.base_length) as i64);
    Some(js_slice(lines, start, end))
}

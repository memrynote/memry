//! `cleanTitle` and `trySeparatorSplit`: stripping the site name from a page title.
//!
//! The JS builds regexes from the site name (`new RegExp(..., 'i')`) and scans with global
//! regexes. Both are matched by hand over `char` slices so that the case folding is JS's (see
//! `canonical`) and the backtracking order is the one the patterns specify.

use crate::web::extract::utils::js::{is_js_whitespace, to_lower, trim};
use crate::web::extract::utils::text::count_words;

/// `{ title, detectedSiteName }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanedTitle {
    pub title: String,
    pub detected_site_name: String,
}

const ALL_SEPARATORS: &[char] = &['|', '-', '\u{2013}', '\u{2014}', '/', '\u{b7}'];
const STRONG_SEPARATORS: &[char] = &['|', '/', '\u{b7}'];
const DASH_SEPARATORS: &[char] = &['-', '\u{2013}', '\u{2014}'];

/// The regex `Canonicalize` of a non-Unicode `i` match: the upper-case form when that is a
/// single UTF-16 unit, unless it would map a non-ASCII character into ASCII.
fn canonical(c: char) -> char {
    if c as u32 > 0xFFFF {
        return c;
    }
    let mut upper = c.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(u), None) if !(c as u32 >= 128 && (u as u32) < 128) && (u as u32) <= 0xFFFF => u,
        _ => c,
    }
}

fn skip_ws(chars: &[char], mut at: usize) -> usize {
    while at < chars.len() && is_js_whitespace(chars[at]) {
        at += 1;
    }
    at
}

/// The ends a `\s*` starting at `at` can take, longest first (greedy order).
fn ws_star_ends(chars: &[char], at: usize) -> impl Iterator<Item = usize> {
    (at..=skip_ws(chars, at)).rev()
}

fn site_at(title: &[char], at: usize, site: &[char]) -> Option<usize> {
    let end = at + site.len();
    (end <= title.len()
        && title[at..end]
            .iter()
            .zip(site)
            .all(|(t, s)| canonical(*t) == canonical(*s)))
    .then_some(end)
}

/// `\s*[sep]\s*<site>\s*$` (case-insensitive): where the first match starts.
fn suffix_site_match(title: &[char], site: &[char]) -> Option<usize> {
    (0..=title.len()).find(|&i| {
        ws_star_ends(title, i).any(|e1| {
            ALL_SEPARATORS.contains(title.get(e1).unwrap_or(&'\0'))
                && ws_star_ends(title, e1 + 1).any(|e2| {
                    site_at(title, e2, site)
                        .is_some_and(|e3| ws_star_ends(title, e3).any(|e4| e4 == title.len()))
                })
        })
    })
}

/// `^\s*<site>\s*[sep]\s*` (case-insensitive): where the match ends.
fn prefix_site_match(title: &[char], site: &[char]) -> Option<usize> {
    ws_star_ends(title, 0).find_map(|e1| {
        let e2 = site_at(title, e1, site)?;
        ws_star_ends(title, e2).find_map(|e3| {
            ALL_SEPARATORS
                .contains(title.get(e3)?)
                .then(|| skip_ws(title, e3 + 1))
        })
    })
}

/// All matches of `/\s+[seps]\s+/g` as `(index, length)`.
fn separator_positions(chars: &[char], separators: &[char]) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut at = 0usize;
    while at < chars.len() {
        let after_lead = skip_ws(chars, at);
        let matched = after_lead > at
            && chars
                .get(after_lead)
                .is_some_and(|c| separators.contains(c))
            && skip_ws(chars, after_lead + 1) > after_lead + 1;
        if matched {
            let end = skip_ws(chars, after_lead + 1);
            found.push((at, end - at));
            at = end;
        } else {
            at += 1;
        }
    }
    found
}

/// `title.substring(start, end)`: swaps the bounds when `start` is past `end`.
fn substring(chars: &[char], start: usize, end: usize) -> String {
    let (from, to) = if start > end {
        (end, start)
    } else {
        (start, end)
    };
    chars[from..to].iter().collect()
}

struct SplitGuard {
    suffix_only: bool,
    guard: fn(usize, usize) -> bool,
}

/// `trySeparatorSplit`.
fn try_separator_split(
    chars: &[char],
    separators: &[char],
    opts: &SplitGuard,
) -> Option<CleanedTitle> {
    let positions = separator_positions(chars, separators);
    let (last_index, last_len) = *positions.last()?;
    let suffix_title = trim(&substring(chars, 0, last_index)).to_string();
    let suffix_site = trim(&substring(chars, last_index + last_len, chars.len())).to_string();
    if (opts.guard)(count_words(&suffix_title), count_words(&suffix_site)) {
        return Some(CleanedTitle {
            title: suffix_title,
            detected_site_name: suffix_site,
        });
    }
    if !opts.suffix_only {
        let (first_index, first_len) = positions[0];
        let prefix_site = trim(&substring(chars, 0, first_index)).to_string();
        let prefix_title =
            trim(&substring(chars, first_index + first_len, chars.len())).to_string();
        if (opts.guard)(count_words(&prefix_title), count_words(&prefix_site)) {
            return Some(CleanedTitle {
                title: prefix_title,
                detected_site_name: prefix_site,
            });
        }
    }
    None
}

/// `cleanTitle(title, siteName)`.
pub fn clean_title(title: &str, site_name: &str) -> CleanedTitle {
    if title.is_empty() {
        return CleanedTitle {
            title: title.to_string(),
            detected_site_name: String::new(),
        };
    }
    let chars: Vec<char> = title.chars().collect();

    if !site_name.is_empty()
        && to_lower(site_name) != to_lower(title)
        && count_words(site_name) <= 6
    {
        let site_lower = to_lower(site_name);
        let site: Vec<char> = site_name.chars().collect();
        if let Some(start) = suffix_site_match(&chars, &site) {
            return CleanedTitle {
                title: trim(&substring(&chars, 0, start)).to_string(),
                detected_site_name: site_name.to_string(),
            };
        }
        if let Some(end) = prefix_site_match(&chars, &site) {
            return CleanedTitle {
                title: trim(&substring(&chars, end, chars.len())).to_string(),
                detected_site_name: site_name.to_string(),
            };
        }

        // Fuzzy match: the title may use an abbreviated site name ("| MDN" for "MDN Web Docs").
        let positions = separator_positions(&chars, ALL_SEPARATORS);
        if let (Some(&(last_index, last_len)), Some(&(first_index, first_len))) =
            (positions.last(), positions.first())
        {
            let last_segment =
                to_lower(trim(&substring(&chars, last_index + last_len, chars.len())));
            if !last_segment.is_empty() && site_lower.contains(&last_segment) {
                let mut cut = last_index;
                for i in (0..positions.len() - 1).rev() {
                    let (index, len) = positions[i];
                    if count_words(trim(&substring(&chars, index + len, cut))) > 3 {
                        break;
                    }
                    cut = index;
                }
                return CleanedTitle {
                    title: trim(&substring(&chars, 0, cut)).to_string(),
                    detected_site_name: site_name.to_string(),
                };
            }
            let prefix_segment = to_lower(trim(&substring(&chars, 0, first_index)));
            if !prefix_segment.is_empty() && site_lower.contains(&prefix_segment) {
                let mut cut = first_index + first_len;
                for &(index, len) in &positions[1..] {
                    if count_words(trim(&substring(&chars, cut, index))) > 3 {
                        break;
                    }
                    cut = index + len;
                }
                return CleanedTitle {
                    title: trim(&substring(&chars, cut, chars.len())).to_string(),
                    detected_site_name: site_name.to_string(),
                };
            }
        }
    }

    // Heuristic fallback: a short segment on one end of a separator is likely the site name.
    let strong = SplitGuard {
        suffix_only: false,
        guard: |title_words, site_words| {
            site_words <= 3 && title_words >= 2 && title_words >= site_words * 2
        },
    };
    if let Some(result) = try_separator_split(&chars, STRONG_SEPARATORS, &strong) {
        return result;
    }
    let dash = SplitGuard {
        suffix_only: true,
        guard: |title_words, site_words| {
            site_words <= 2 && title_words >= 2 && title_words > site_words
        },
    };
    if let Some(result) = try_separator_split(&chars, DASH_SEPARATORS, &dash) {
        return result;
    }
    CleanedTitle {
        title: trim(title).to_string(),
        detected_site_name: String::new(),
    }
}

//! The fuzzy title fallback's scorer (#4319): a port of fuzzysort 3.1.0, the
//! library desktop's `fuzzySearchTitles` calls with `threshold: 0.3` and the
//! query's limit.
//!
//! A port rather than a crate so a typo ranks the same titles on both apps:
//! fuzzysort's score is its own formula, and no Rust matcher reproduces it.
//! Only what `go(search, targets, { key, threshold, limit })` reaches is here.
//! Positions are UTF-16 code units, as JavaScript counts them, because every
//! penalty is a distance between positions. Desktop's scores for a fixed title
//! list are pasted into the parity test below.

use std::f64::consts::E;

use unicode_normalization::UnicodeNormalization as _;

/// Desktop's `FUZZYSORT_THRESHOLD`, on fuzzysort's normalized 0..1 scale.
const THRESHOLD: f64 = 0.3;

/// The indexes into `titles` that match `search`, best first, each with its
/// normalized score, at most `limit`. Empty titles never match.
pub(super) fn rank<'a>(
    search: &str,
    titles: impl IntoIterator<Item = &'a str>,
    limit: usize,
) -> Vec<(usize, f64)> {
    let query = Query::new(search);
    let threshold = denormalize(THRESHOLD);
    let mut found: Vec<(usize, f64)> = titles
        .into_iter()
        .enumerate()
        .filter(|(_, title)| !title.is_empty())
        .filter_map(|(at, title)| {
            let mut target = Target::new(title);
            if query.bitflags & target.bitflags != query.bitflags {
                return None;
            }
            let score = query.score(&mut target)?;
            (score >= threshold).then_some((at, score))
        })
        .collect();
    found.sort_by(|a, b| b.1.total_cmp(&a.1));
    found.truncate(limit);
    found
        .into_iter()
        .map(|(at, score)| (at, normalize(score)))
        .collect()
}

fn normalize(score: f64) -> f64 {
    if score == f64::NEG_INFINITY {
        0.0
    } else if score > 1.0 {
        score
    } else {
        E.powf(((1.0 - score).powf(0.04307) - 1.0) * -2.0)
    }
}

fn denormalize(normalized: f64) -> f64 {
    if normalized == 0.0 {
        f64::NEG_INFINITY
    } else if normalized > 1.0 {
        normalized
    } else {
        1.0 - (normalized.ln() / -2.0 + 1.0).powf(1.0 / 0.04307)
    }
}

/// fuzzysort's `remove_accents`: Latin-script characters decomposed, then
/// every U+0300..U+036F mark dropped, so `ş` reads as `s` and a Japanese mark
/// stays. The ranges are the Latin characters that have a canonical
/// decomposition; decomposing any other Latin character changes nothing.
fn remove_accents(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\u{C0}'..='\u{24F}' | '\u{1E00}'..='\u{1EFF}' | '\u{212A}'..='\u{212B}') {
            out.extend(c.nfd());
        } else {
            out.push(c);
        }
    }
    out.retain(|c| !('\u{300}'..='\u{36F}').contains(&c));
    out
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `prepareLowerInfo`: the lowercased, accent-free code units, the full
/// lowercased text for substring checks, the letter bitflags, and whether a
/// space is present.
struct LowerInfo {
    codes: Vec<u16>,
    lower: Vec<u16>,
    bitflags: u32,
    contains_space: bool,
}

impl LowerInfo {
    fn new(text: &str) -> Self {
        let text = remove_accents(text);
        let lower = utf16(&text.to_lowercase());
        let codes: Vec<u16> = lower
            .iter()
            .copied()
            .take(text.encode_utf16().count())
            .collect();
        let mut bitflags = 0u32;
        let mut contains_space = false;
        for &code in &codes {
            if code == 32 {
                contains_space = true;
                continue;
            }
            let bit = match code {
                97..=122 => code - 97,
                48..=57 => 26,
                0..=127 => 30,
                _ => 31,
            };
            bitflags |= 1 << bit;
        }
        Self {
            codes,
            lower,
            bitflags,
            contains_space,
        }
    }
}

/// One search string: its code units and the text its substring check uses.
struct Needle {
    codes: Vec<u16>,
    lower: Vec<u16>,
}

struct Query {
    whole: Needle,
    bitflags: u32,
    /// The distinct whitespace-separated words, when the search holds a space.
    words: Vec<Needle>,
}

impl Query {
    fn new(search: &str) -> Self {
        let search = search
            .trim_matches(|c: char| c != '\u{0085}' && (c.is_whitespace() || c == '\u{FEFF}'));
        let info = LowerInfo::new(search);
        let mut words: Vec<Needle> = Vec::new();
        if info.contains_space {
            let mut seen: Vec<&str> = Vec::new();
            for word in search.split(|c: char| c.is_whitespace() || c == '\u{FEFF}') {
                if word.is_empty() || seen.contains(&word) {
                    continue;
                }
                seen.push(word);
                // fuzzysort checks a word's substring against its plain
                // lowercase, accents kept.
                words.push(Needle {
                    codes: LowerInfo::new(word).codes,
                    lower: utf16(&word.to_lowercase()),
                });
            }
        }
        Self {
            whole: Needle {
                codes: info.codes,
                lower: info.lower,
            },
            bitflags: info.bitflags,
            words,
        }
    }

    /// The raw score, or `None` when `target` does not hold every character.
    fn score(&self, target: &mut Target) -> Option<f64> {
        if self.words.is_empty() {
            return algorithm(&self.whole, target).map(|found| found.score);
        }
        self.score_words(target)
    }

    /// `algorithmSpaces`: each word must match, a word that matched as one
    /// run makes its end a word start for the next, and a later word found
    /// before an earlier one loses points. The whole search, spaces included,
    /// wins when it scores better.
    fn score_words(&self, target: &mut Target) -> Option<f64> {
        let count = self.words.len() as f64;
        let mut score = 0.0;
        let mut first_seen_last = 0usize;
        let mut changes: Vec<(usize, usize)> = Vec::new();
        let mut matched = true;
        for (at, word) in self.words.iter().enumerate() {
            let Some(found) = algorithm(word, target) else {
                matched = false;
                break;
            };
            let indexes = &found.indexes;
            if at != self.words.len() - 1 && indexes.windows(2).all(|pair| pair[1] - pair[0] == 1) {
                let start = indexes[indexes.len() - 1] + 1;
                let replaced = target.next_beginning[start - 1];
                for i in (0..start).rev() {
                    if target.next_beginning[i] != replaced {
                        break;
                    }
                    target.next_beginning[i] = start;
                    changes.push((i, replaced));
                }
            }
            score += found.score / count;
            if indexes[0] < first_seen_last {
                score -= ((first_seen_last - indexes[0]) * 2) as f64;
            }
            first_seen_last = indexes[0];
        }
        for &(i, replaced) in changes.iter().rev() {
            target.next_beginning[i] = replaced;
        }
        if !matched {
            return None;
        }
        match algorithm(&self.whole, target) {
            Some(whole) if whole.score > score => Some(whole.score),
            _ => Some(score),
        }
    }
}

struct Target {
    codes: Vec<u16>,
    lower: Vec<u16>,
    bitflags: u32,
    /// For each position, the next position that starts a word.
    next_beginning: Vec<usize>,
}

impl Target {
    fn new(title: &str) -> Self {
        let info = LowerInfo::new(title);
        Self {
            next_beginning: next_beginning_indexes(&utf16(&remove_accents(title))),
            codes: info.codes,
            lower: info.lower,
            bitflags: info.bitflags,
        }
    }
}

/// `prepareBeginningIndexes`: a word starts at an uppercase letter after a
/// non-uppercase one, and at every non-alphanumeric unit and the one after it.
fn next_beginning_indexes(target: &[u16]) -> Vec<usize> {
    let mut beginnings = Vec::new();
    let (mut was_upper, mut was_alphanumeric) = (false, false);
    for (i, &code) in target.iter().enumerate() {
        let upper = (65..=90).contains(&code);
        let alphanumeric = upper || (97..=122).contains(&code) || (48..=57).contains(&code);
        if (upper && !was_upper) || !was_alphanumeric || !alphanumeric {
            beginnings.push(i);
        }
        was_upper = upper;
        was_alphanumeric = alphanumeric;
    }
    let mut next = Vec::with_capacity(target.len());
    let mut at = 0;
    for i in 0..target.len() {
        while at < beginnings.len() && beginnings[at] <= i {
            at += 1;
        }
        next.push(beginnings.get(at).copied().unwrap_or(target.len()));
    }
    next
}

struct Found {
    score: f64,
    indexes: Vec<usize>,
}

/// fuzzysort's `algorithm` for one word: every character in order, then a
/// stricter pass that only matches at runs or word starts, then a substring
/// check, and the penalties over the best of those.
fn algorithm(needle: &Needle, target: &Target) -> Option<Found> {
    let search = &needle.codes;
    let codes = &target.codes;
    let next = &target.next_beginning;
    let (search_len, target_len) = (search.len(), codes.len());
    if search_len == 0 || target_len == 0 {
        return None;
    }

    let mut simple = vec![0usize; search_len];
    let (mut s, mut t) = (0, 0);
    loop {
        if search[s] == codes[t] {
            simple[s] = t;
            s += 1;
            if s == search_len {
                break;
            }
        }
        t += 1;
        if t >= target_len {
            return None;
        }
    }

    let mut strict = vec![0usize; search_len];
    let (mut s, mut strict_len, mut backtracks) = (0, 0, 0);
    let mut success_strict = false;
    let mut t = if simple[0] == 0 {
        0
    } else {
        next[simple[0] - 1]
    };
    if t != target_len {
        loop {
            if t >= target_len {
                if s == 0 {
                    break;
                }
                backtracks += 1;
                if backtracks > 200 {
                    break;
                }
                s -= 1;
                strict_len -= 1;
                t = next[strict[strict_len]];
            } else if search[s] == codes[t] {
                strict[strict_len] = t;
                strict_len += 1;
                s += 1;
                if s == search_len {
                    success_strict = true;
                    break;
                }
                t += 1;
            } else {
                t = next[t];
            }
        }
    }

    let mut substring = if search_len <= 1 {
        None
    } else {
        index_of(&target.lower, &needle.lower, simple[0])
    };
    let mut substring_beginning =
        substring.is_some_and(|at| at == 0 || next.get(at - 1) == Some(&at));
    if let Some(found_at) = substring.filter(|_| !substring_beginning) {
        let mut i = 0;
        while i < next.len() {
            if i > found_at && (0..search_len).all(|s| codes.get(i + s) == Some(&search[s])) {
                substring = Some(i);
                substring_beginning = true;
                break;
            }
            i = next[i];
        }
    }

    let score_of = |matches: &[usize]| {
        let mut score = 0.0;
        let mut extra_groups = 0i64;
        for i in 1..search_len {
            if matches[i] as i64 - matches[i - 1] as i64 != 1 {
                score -= matches[i] as f64;
                extra_groups += 1;
            }
        }
        let unmatched =
            matches[search_len - 1] as i64 - matches[0] as i64 - (search_len as i64 - 1);
        score -= ((12 + unmatched) * extra_groups) as f64;
        if matches[0] != 0 {
            score -= (matches[0] * matches[0]) as f64 * 0.2;
        }
        if !success_strict {
            score *= 1000.0;
        } else {
            let mut beginnings = 1;
            let mut i = next[0];
            while i < target_len {
                beginnings += 1;
                i = next[i];
            }
            if beginnings > 24 {
                score *= ((beginnings - 24) * 10) as f64;
            }
        }
        let longer = (target_len as f64 - search_len as f64) / 2.0;
        let squared = (search_len * search_len) as f64;
        score -= longer;
        if substring.is_some() {
            score /= 1.0 + squared;
        }
        if substring_beginning {
            score /= 1.0 + squared;
        }
        score - longer
    };

    let run = |at: usize| (at..at + search_len).collect::<Vec<_>>();
    let best = match (success_strict, substring) {
        (false, Some(at)) => run(at),
        (false, None) => simple,
        (true, Some(at)) if substring_beginning => run(at),
        (true, _) => strict,
    };
    Some(Found {
        score: score_of(&best),
        indexes: best,
    })
}

/// JavaScript's `indexOf` over code units, from `from`.
fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&at| haystack[at..].starts_with(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TITLES: [&str; 15] = [
        "Password list",
        "Meeting notes personal",
        "Şifre notları",
        "Grocery",
        "Rotate credentials",
        "Café résumé",
        "Passport renewal",
        "Weekly meeting agenda",
        "passwords",
        "Notes on Pass Word",
        "Personal assistant swords overview",
        "PassWordManager",
        "naïve café notes",
        "Kişisel şifreler",
        "",
    ];

    /// Desktop's answers: fuzzysort 3.1.0's `go(query, TITLES.map(t => ({title: t})),
    /// {key: 'title', threshold: 0.3, limit: 20})`, title and `score` pasted
    /// from `/tmp/ship-epic-4314/4319/fixture.cjs`.
    const DESKTOP: [(&str, &[(&str, f64)]); 14] = [
        (
            "pasword",
            &[
                ("PassWordManager", 0.7398571145107795),
                ("Notes on Pass Word", 0.684557999428046),
                ("Personal assistant swords overview", 0.6359934333110061),
                ("passwords", 0.3525520327014226),
                ("Password list", 0.35254116555072385),
            ],
        ),
        ("passwrod", &[]),
        (
            "meetng",
            &[
                ("Meeting notes personal", 0.3498827007576675),
                ("Weekly meeting agenda", 0.32047904561039625),
            ],
        ),
        ("creds", &[("Rotate credentials", 0.309671712178955)]),
        (
            "şifr",
            &[
                ("Şifre notları", 0.8584434212346949),
                ("Kişisel şifreler", 0.8388595946971493),
            ],
        ),
        ("cafe resume", &[("Café résumé", 1.0)]),
        (
            "meeting notes",
            &[("Meeting notes personal", 0.8586661898520123)],
        ),
        (
            "pass",
            &[
                ("passwords", 0.8948476302878543),
                ("Password list", 0.8584434212346949),
                ("PassWordManager", 0.8451952462509957),
                ("Passport renewal", 0.8393540150190916),
                ("Notes on Pass Word", 0.8283411858958392),
                ("Personal assistant swords overview", 0.6799777018068718),
            ],
        ),
        (
            "word list",
            &[
                ("Password list", 0.7050801695634273),
                ("Personal assistant swords overview", 0.3422393509558359),
            ],
        ),
        (
            "notes",
            &[
                ("naïve café notes", 0.8448943332683237),
                ("Notes on Pass Word", 0.8340700581624063),
                ("Meeting notes personal", 0.815500039125134),
            ],
        ),
        // "Personal assistant swords overview" scores 0.2747 here, under the
        // threshold.
        ("naive", &[("naïve café notes", 0.8453272712812543)]),
        (
            "sifre",
            &[
                ("Şifre notları", 0.8661785547133217),
                ("Kişisel şifreler", 0.8450979685513827),
            ],
        ),
        (
            "p",
            &[
                ("passwords", 0.8199483535594311),
                ("Password list", 0.7916697313914934),
                ("PassWordManager", 0.780812663853934),
                ("Passport renewal", 0.7759433138095349),
                ("Personal assistant swords overview", 0.7203328365130806),
                ("Notes on Pass Word", 0.7199092882726241),
                ("Meeting notes personal", 0.6785949297674901),
            ],
        ),
        ("   ", &[]),
    ];

    #[test]
    fn every_query_ranks_the_titles_desktop_ranks_with_its_scores() {
        for (query, expected) in DESKTOP {
            let ranked = rank(query, TITLES, 20);
            let titles: Vec<&str> = ranked.iter().map(|&(at, _)| TITLES[at]).collect();
            let wanted: Vec<&str> = expected.iter().map(|&(title, _)| title).collect();
            assert_eq!(titles, wanted, "{query:?}");
            for (&(_, score), &(title, desktop)) in ranked.iter().zip(expected) {
                assert!(
                    (score - desktop).abs() < 1e-9,
                    "{query:?} {title}: {score} vs desktop {desktop}"
                );
            }
        }
    }

    #[test]
    fn the_limit_keeps_the_best() {
        let ranked = rank("pass", TITLES, 2);
        let titles: Vec<&str> = ranked.iter().map(|&(at, _)| TITLES[at]).collect();
        assert_eq!(titles, ["passwords", "Password list"]);
    }
}

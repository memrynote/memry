//! The string helpers of `@metascraper/helpers` 5.49.21: `condense-whitespace` 2.0.0,
//! `smartquotes` 2.3.2 (string mode), `titleize` and the `description`, `author`, `publisher` and
//! `title` mappers.
//!
//! JavaScript regexes without the `u` flag treat `\w`, `\b` and `i` as ASCII, so the patterns
//! here spell the ASCII classes out. `\s` and `trim` use the ECMAScript whitespace set.

use std::sync::LazyLock;

use regex::Regex;

use super::url::is_url;
use crate::web::extract::utils::js::is_js_whitespace;

/// ECMAScript `\s` as a regex class body.
const JS_WS: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("JSWS", JS_WS)).expect("static pattern")
}

/// `condenseWhitespace`: `string.trim().replace(/\s{2,}/g, ' ')`.
pub fn condense(value: &str) -> String {
    let trimmed = value.trim_matches(is_js_whitespace);
    let mut out = String::with_capacity(trimmed.len());
    let mut run = String::new();
    for c in trimmed.chars() {
        if is_js_whitespace(c) {
            run.push(c);
            continue;
        }
        flush_run(&mut out, &mut run);
        out.push(c);
    }
    flush_run(&mut out, &mut run);
    out
}

fn flush_run(out: &mut String, run: &mut String) {
    if run.chars().nth(1).is_some() {
        out.push(' ');
    } else {
        out.push_str(run);
    }
    run.clear();
}

/// smartquotes' replacement list in order; the tenth entry has a lookahead and runs in
/// [`closing_single_quotes`].
static SMARTQUOTES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (re("'''"), "\u{2034}"),
        (
            re(r#"([^0-9A-Za-z_]|^)"([0-9A-Za-z_])"#),
            "${1}\u{201c}${2}",
        ),
        (
            re("(\u{201c}[^\"]*)\"([^\"]*$|[^\u{201c}\"]*\u{201c})"),
            "${1}\u{201d}${2}",
        ),
        (re(r#"([^0-9])""#), "${1}\u{201d}"),
        (re("''"), "\u{2033}"),
        (re("([^0-9A-Za-z_]|^)'([^JSWS])"), "${1}\u{2018}${2}"),
        (re("([a-zA-Z0-9])'([a-zA-Z])"), "${1}\u{2019}${2}"),
        (
            re("(\u{2018})([0-9]{2}[^\u{2019}]*)(\u{2018}([^0-9]|$)|$|\u{2019}[a-zA-Z])"),
            "\u{2019}${2}${3}",
        ),
        (
            re("((\u{2018}[^']*)|[a-zA-Z])'([^0-9]|$)"),
            "${1}\u{2019}${3}",
        ),
    ]
});

static DOUBLE: LazyLock<Regex> = LazyLock::new(|| re("\""));
static SINGLE: LazyLock<Regex> = LazyLock::new(|| re("'"));

/// `smartquotes(string)`.
pub fn smartquotes(value: &str) -> String {
    let mut out = value.to_owned();
    for (pattern, replacement) in SMARTQUOTES.iter() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out = closing_single_quotes(&out);
    out = DOUBLE.replace_all(&out, "\u{2033}").into_owned();
    SINGLE.replace_all(&out, "\u{2032}").into_owned()
}

const OPEN: char = '\u{2018}';
const CLOSE: char = '\u{2019}';

fn is_word(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
}

fn is_quote(c: char) -> bool {
    c == OPEN || c == CLOSE
}

/// `/(\B|^)\u2018(?=([^\u2018\u2019]*\u2019\b)*([^\u2018\u2019]*\B\W[\u2018\u2019]\b|[^\u2018\u2019]*$))/ig`
/// replaced by `$1\u2019`: an opening quote after a non-word character that the rest of the
/// text closes becomes a closing one. Every match is found on the input, as `replace` does.
fn closing_single_quotes(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    // next_quote[i]: the first quote at or after i.
    let mut next_quote = vec![chars.len(); chars.len() + 1];
    for i in (0..chars.len()).rev() {
        next_quote[i] = if is_quote(chars[i]) {
            i
        } else {
            next_quote[i + 1]
        };
    }
    let lookahead = |mut i: usize| -> bool {
        loop {
            let first = next_quote[i];
            if first == chars.len() {
                return true;
            }
            // `[^‘’]*\B\W[‘’]\b`: `\W` at j, ending the quote-free run or being its first quote.
            let tail_from = i;
            for j in tail_from..=first.min(chars.len() - 1) {
                let w = chars[j];
                if is_word(Some(&w)) {
                    continue;
                }
                let boundary_free = !is_word(j.checked_sub(1).and_then(|k| chars.get(k)));
                if boundary_free
                    && chars.get(j + 1).is_some_and(|&c| is_quote(c))
                    && is_word(chars.get(j + 2))
                {
                    return true;
                }
            }
            // `[^‘’]*’\b`, then the loop again.
            if chars[first] == CLOSE && is_word(chars.get(first + 1)) {
                i = first + 1;
            } else {
                return false;
            }
        }
    };
    let mut out = String::with_capacity(value.len());
    for (p, &c) in chars.iter().enumerate() {
        let after_non_word = p == 0 || !is_word(chars.get(p - 1));
        if c == OPEN && after_non_word && lookahead(p + 1) {
            out.push(CLOSE);
        } else {
            out.push(c);
        }
    }
    out
}

static BY: LazyLock<Regex> = LazyLock::new(|| re("(?i)^[JSWS\n]*by[JSWS\n]+|@[JSWS\n]*"));
static LOCATION: LazyLock<Regex> =
    LazyLock::new(|| re("^[A-ZJSWS]+[JSWS]+[-\u{2014}\u{2013}][JSWS]+"));
static ELLIPSIS: LazyLock<Regex> = LazyLock::new(|| re(r"[JSWS]?\.\.\.?$"));

/// `titleize(src, { removeBy })` without the separator and capitalize options, which no rule
/// of the eight bundles sets.
fn titleize(value: &str, remove_by: bool) -> String {
    let title = smartquotes(&condense(value));
    if remove_by {
        return condense(&BY.replace(&title, ""));
    }
    title
}

/// `title(value)`.
pub fn title(value: &str) -> String {
    titleize(value, false)
}

/// `publisher(value)`.
pub fn publisher(value: &str) -> String {
    condense(value)
}

/// `description(value)`: no truncation (`truncateLength` defaults to `MAX_SAFE_INTEGER`).
pub fn description(value: &str) -> String {
    let without_location = LOCATION.replace(value, "");
    ELLIPSIS
        .replace(&titleize(&without_location, false), "\u{2026}")
        .into_owned()
}

const AUTHOR_MAX_LENGTH: usize = 128;

/// `author(value)`: `isAuthor` (not a URL, not empty, at most 128 symbols), then `titleize`
/// with `removeBy`.
pub fn author(value: &str) -> Option<String> {
    if value.is_empty() || is_url(value) || lodash_size(value) > AUTHOR_MAX_LENGTH {
        return None;
    }
    Some(titleize(value, true))
}

/// lodash `size(string)`: symbols, where a combining mark, a variation selector or a zero-width
/// joiner and the code point it joins belong to the symbol before.
fn lodash_size(value: &str) -> usize {
    let mut count = 0;
    let mut joined = false;
    for c in value.chars() {
        let combining = matches!(
            c,
            '\u{300}'..='\u{36f}' | '\u{fe20}'..='\u{fe2f}' | '\u{20d0}'..='\u{20ff}' | '\u{fe0e}' | '\u{fe0f}'
        );
        if c == '\u{200d}' {
            joined = count > 0;
            continue;
        }
        if !(combining && count > 0) && !joined {
            count += 1;
        }
        joined = false;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values: the JavaScript functions on the same input (node, 2.3.2 / 2.0.0).
    #[test]
    fn smartquotes_matches_the_library() {
        assert_eq!(smartquotes(r#"He said "hi""#), "He said \u{201c}hi\u{201d}");
        assert_eq!(
            smartquotes("it's 'quoted'"),
            "it\u{2019}s \u{2018}quoted\u{2019}"
        );
        assert_eq!(smartquotes("'90s rock"), "\u{2019}90s rock");
        assert_eq!(smartquotes("6'2\""), "6\u{2032}2\u{2033}");
    }

    #[test]
    fn condense_keeps_single_whitespace() {
        assert_eq!(condense("  a \n b\nc  "), "a b\nc");
    }
}

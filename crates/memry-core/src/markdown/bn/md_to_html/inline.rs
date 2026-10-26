//! Inline parser: `parseInline` and its tokenizers.

use super::scan::{is_js_ws, trim};
use super::video::is_video_url;
use crate::markdown::limits::{DepthGuard, MAX_INLINE_DEPTH};

type Tok = Option<(String, usize)>;

pub(super) fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn esc(l: &[char]) -> String {
    escape_html(&l.iter().collect::<String>())
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn intraword(t: &[char], i: usize, dl: usize) -> bool {
    let before = if i > 0 { Some(t[i - 1]) } else { None };
    is_word(before) && is_word(t.get(i + dl).copied())
}

fn is_special(c: char) -> bool {
    matches!(c, '\\' | '`' | '!' | '[' | '~' | '*' | '_' | '\n' | '<')
}

pub(super) fn parse_inline(text: &str) -> String {
    let cs: Vec<char> = text.chars().collect();
    parse_chars(&cs)
}

fn parse_chars(text: &[char]) -> String {
    let Some(_level) = DepthGuard::enter(MAX_INLINE_DEPTH) else {
        return String::new();
    };
    let mut result = String::new();
    let mut i = 0;
    while i < text.len() {
        if text[i] == '\n' && i >= 2 && text[i - 1] == ' ' && text[i - 2] == ' ' {
            let kept = result.trim_end_matches(' ').len();
            result.truncate(kept);
            result.push_str("<br>\n");
            i += 1;
            continue;
        }
        if is_special(text[i])
            && let Some((html, end)) = try_tokenizers(text, i)
        {
            result.push_str(&html);
            i = end;
            continue;
        }
        let start = i;
        i += 1;
        while i < text.len() && !is_special(text[i]) {
            i += 1;
        }
        result.push_str(&esc(&text[start..i]));
    }
    result
}

fn try_tokenizers(t: &[char], i: usize) -> Tok {
    backslash(t, i)
        .or_else(|| (t[i] == '`').then(|| parse_inline_code(t, i)).flatten())
        .or_else(|| {
            (t[i] == '!' && t.get(i + 1) == Some(&'['))
                .then(|| parse_image(t, i))
                .flatten()
        })
        .or_else(|| (t[i] == '[').then(|| parse_link(t, i)).flatten())
        .or_else(|| {
            (t[i] == '~' && t.get(i + 1) == Some(&'~'))
                .then(|| parse_delimited(t, i, &['~', '~'], "<del>", "</del>"))
                .flatten()
        })
        .or_else(|| bold_italic(t, i))
        .or_else(|| bold(t, i))
        .or_else(|| italic(t, i))
        .or_else(|| (t[i] == '<').then(|| inline_html(t, i)).flatten())
        .or_else(|| (t[i] == '\n').then(|| ("<br>\n".to_string(), i + 1)))
}

fn backslash(t: &[char], i: usize) -> Tok {
    if t[i] != '\\' || i + 1 >= t.len() {
        return None;
    }
    let next = t[i + 1];
    if next == '\n' {
        return Some(("<br>\n".to_string(), i + 2));
    }
    if "\\`*_{}[]()#+-.!~|>".contains(next) {
        return Some((escape_html(&next.to_string()), i + 2));
    }
    None
}

fn bold_italic(t: &[char], i: usize) -> Tok {
    let c = t[i];
    let run3 = t.get(i + 1) == Some(&c) && t.get(i + 2) == Some(&c);
    if (c == '*' && run3) || (c == '_' && run3 && !intraword(t, i, 3)) {
        return parse_delimited(t, i, &t[i..i + 3], "<strong><em>", "</em></strong>");
    }
    None
}

fn bold(t: &[char], i: usize) -> Tok {
    let c = t[i];
    let run2 = t.get(i + 1) == Some(&c);
    if (c == '*' && run2) || (c == '_' && run2 && !intraword(t, i, 2)) {
        return parse_delimited(t, i, &t[i..i + 2], "<strong>", "</strong>");
    }
    None
}

fn italic(t: &[char], i: usize) -> Tok {
    if t[i] == '*' || (t[i] == '_' && !intraword(t, i, 1)) {
        return parse_delimited(t, i, &t[i..i + 1], "<em>", "</em>");
    }
    None
}

fn find_from(t: &[char], from: usize, pat: &str) -> Option<usize> {
    let p: Vec<char> = pat.chars().collect();
    if from > t.len() {
        return None;
    }
    (from..t.len()).find(|&k| t[k..].starts_with(&p))
}

fn terminated(t: &[char], i: usize, head: &str, term: &str) -> Option<usize> {
    let h: Vec<char> = head.chars().collect();
    if !t[i..].starts_with(&h) {
        return None;
    }
    find_from(t, i + h.len(), term).map(|e| e + term.chars().count())
}

fn inline_html(t: &[char], i: usize) -> Tok {
    let decl = || {
        if t[i..].starts_with(&['<', '!']) && t.get(i + 2).is_some_and(|c| c.is_ascii_alphabetic())
        {
            (i + 3..t.len()).find(|&k| t[k] == '>').map(|e| e + 1)
        } else {
            None
        }
    };
    let end = terminated(t, i, "<!--", "-->")
        .or_else(|| terminated(t, i, "<![CDATA[", "]]>"))
        .or_else(|| terminated(t, i, "<?", "?>"))
        .or_else(decl)
        .or_else(|| html_tag_end(t, i))?;
    Some((t[i..end].iter().collect(), end))
}

/// INLINE_HTML_TAG_RE. Every quantifier is followed by a character class that
/// cannot continue it, so the regex has no useful backtracking and this
/// deterministic scan accepts exactly the same strings.
fn html_tag_end(t: &[char], i: usize) -> Option<usize> {
    let skip_ws = |mut p: usize| {
        while t.get(p).is_some_and(|&c| is_js_ws(c)) {
            p += 1;
        }
        p
    };
    let mut p = i + 1;
    if t.get(p) == Some(&'/') {
        p += 1;
    }
    if !t.get(p)?.is_ascii_alphabetic() {
        return None;
    }
    while t
        .get(p)
        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '-')
    {
        p += 1;
    }
    loop {
        let q = skip_ws(p);
        if q == p
            || !t
                .get(q)
                .is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '_' | ':'))
        {
            break;
        }
        p = q;
        while t
            .get(p)
            .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
        {
            p += 1;
        }
        let r = skip_ws(p);
        if t.get(r) != Some(&'=') {
            continue;
        }
        let v = skip_ws(r + 1);
        match t.get(v)? {
            &q @ ('"' | '\'') => {
                p = v + 1 + t[v + 1..].iter().position(|&c| c == q)? + 1;
            }
            _ => {
                let n = t[v..]
                    .iter()
                    .take_while(|&&c| {
                        !is_js_ws(c) && !matches!(c, '"' | '\'' | '=' | '<' | '>' | '`')
                    })
                    .count();
                if n == 0 {
                    return None;
                }
                p = v + n;
            }
        }
    }
    p = skip_ws(p);
    if t.get(p) == Some(&'/') {
        p += 1;
    }
    (t.get(p) == Some(&'>')).then_some(p + 1)
}

fn parse_inline_code(t: &[char], start: usize) -> Tok {
    let mut i = start;
    while i < t.len() && t[i] == '`' {
        i += 1;
    }
    let open = i - start;
    let mut j = i;
    while j < t.len() {
        if t[j] == '`' {
            let close_start = j;
            while j < t.len() && t[j] == '`' {
                j += 1;
            }
            if j - close_start == open {
                let mut code: Vec<char> = t[i..close_start]
                    .iter()
                    .map(|&c| if c == '\n' { ' ' } else { c })
                    .collect();
                if code.len() >= 2
                    && code[0] == ' '
                    && code[code.len() - 1] == ' '
                    && code.iter().any(|&c| c != ' ')
                {
                    code = code[1..code.len() - 1].to_vec();
                }
                return Some((format!("<code>{}</code>", esc(&code)), j));
            }
        } else {
            j += 1;
        }
    }
    None
}

fn find_closing(t: &[char], open_pos: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0i64;
    let mut i = open_pos;
    while i < t.len() {
        if t[i] == '\\' && i + 1 < t.len() {
            i += 2;
            continue;
        }
        if t[i] == open {
            depth += 1;
        }
        if t[i] == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn title_attr(title: &Option<String>) -> String {
    title
        .as_ref()
        .map_or_else(String::new, |t| format!(" title=\"{}\"", escape_html(t)))
}

fn parse_image(t: &[char], start: usize) -> Tok {
    let alt_end = find_closing(t, start + 1, '[', ']')?;
    if t.get(alt_end + 1) != Some(&'(') {
        return None;
    }
    let url_start = alt_end + 2;
    let paren_end = find_closing(t, url_start - 1, '(', ')')?;
    let alt: String = t[start + 2..alt_end].iter().collect();
    let (url, title) = parse_destination_and_title(&t[url_start..paren_end]);
    if is_video_url(&url) {
        let name = if alt.is_empty() {
            title.clone().unwrap_or_default()
        } else {
            alt
        };
        let name_attr = if name.is_empty() {
            String::new()
        } else {
            format!(" data-name=\"{}\"", escape_html(&name))
        };
        return Some((
            format!(
                "<video src=\"{0}\"{name_attr} data-url=\"{0}\" controls></video>",
                escape_html(&url)
            ),
            paren_end + 1,
        ));
    }
    Some((
        format!(
            "<img src=\"{}\" alt=\"{}\"{}>",
            escape_html(&url),
            escape_html(&alt),
            title_attr(&title)
        ),
        paren_end + 1,
    ))
}

fn parse_link(t: &[char], start: usize) -> Tok {
    let text_end = find_closing(t, start, '[', ']')?;
    if t.get(text_end + 1) != Some(&'(') {
        return None;
    }
    let paren_end = find_closing(t, text_end + 1, '(', ')')?;
    let (url, title) = parse_destination_and_title(&t[text_end + 2..paren_end]);
    Some((
        format!(
            "<a href=\"{}\"{}>{}</a>",
            escape_html(&url),
            title_attr(&title),
            parse_chars(&t[start + 1..text_end])
        ),
        paren_end + 1,
    ))
}

fn parse_destination_and_title(raw: &[char]) -> (String, Option<String>) {
    let raw = trim(raw);
    let (url, rest): (&[char], &[char]) = if raw.first() == Some(&'<') {
        match raw.iter().position(|&c| c == '>') {
            None => (&raw[1..], &[]),
            Some(close) => (&raw[1..close], trim(&raw[close + 1..])),
        }
    } else {
        let mut split = raw.len();
        let mut i = 0;
        while i < raw.len() {
            if raw[i] == '\\' && i + 1 < raw.len() {
                i += 2;
                continue;
            }
            if matches!(raw[i], ' ' | '\t' | '\n') {
                split = i;
                break;
            }
            i += 1;
        }
        (&raw[..split], trim(&raw[split..]))
    };
    let title = (rest.len() >= 2)
        .then(|| {
            let (first, last) = (rest[0], rest[rest.len() - 1]);
            let inner = &rest[1..rest.len() - 1];
            let (want_close, banned) = match first {
                '"' => ('"', '"'),
                '\'' => ('\'', '\''),
                '(' => (')', ')'),
                _ => return None,
            };
            (last == want_close && !inner.contains(&banned))
                .then(|| inner.iter().collect::<String>())
        })
        .flatten();
    (url.iter().collect(), title)
}

fn parse_delimited(t: &[char], start: usize, delim: &[char], open: &str, close: &str) -> Tok {
    let len = delim.len();
    let after = start + len;
    if after >= t.len() || matches!(t[after], ' ' | '\t') {
        return None;
    }
    let mut j = after;
    while j < t.len() {
        if t[j] == '\\' && j + 1 < t.len() {
            j += 2;
            continue;
        }
        if t[j..].starts_with(delim) {
            if matches!(t[j - 1], ' ' | '\t') {
                j += 1;
                continue;
            }
            if len == 1
                && ((j > 0 && t[j - 1] == delim[0] && !(j >= 2 && t[j - 2] == '\\'))
                    || (j + len < t.len() && t[j + len] == delim[0]))
            {
                j += 1;
                continue;
            }
            if j == after {
                j += 1;
                continue;
            }
            return Some((
                format!("{open}{}{close}", parse_chars(&t[after..j])),
                j + len,
            ));
        }
        j += 1;
    }
    None
}

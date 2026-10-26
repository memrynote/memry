//! Hand-written scanners for the line-level regexes of `markdownToHtml.ts`.
//!
//! Lines are `&[char]`: every syntax character is ASCII and the only counted
//! prefixes are JS-whitespace (all BMP), so char counts equal UTF-16 counts.

/// JS `\s` and `String.prototype.trim` whitespace.
pub(super) fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// JS `.`: everything except line terminators.
pub(super) fn dotable(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub(super) fn trim(l: &[char]) -> &[char] {
    let s = l.iter().take_while(|&&c| is_js_ws(c)).count();
    let l = &l[s..];
    let e = l.iter().rev().take_while(|&&c| is_js_ws(c)).count();
    &l[..l.len() - e]
}

pub(super) fn chars_to_string(l: &[char]) -> String {
    l.iter().collect()
}

pub(super) fn is_blank(l: &[char]) -> bool {
    l.iter().all(|&c| is_js_ws(c))
}

/// `^\s*` length.
pub(super) fn ws_len(l: &[char]) -> usize {
    l.iter().take_while(|&&c| is_js_ws(c)).count()
}

fn all_ws(l: &[char]) -> bool {
    l.iter().all(|&c| is_js_ws(c))
}

fn spaces_upto3(l: &[char]) -> usize {
    l.iter().take(3).take_while(|&&c| c == ' ').count()
}

/// `^ {0,3}(`{3,}|~{3,})(.*)$` -> (fence char, fence length, trimmed info string).
pub(super) fn fence_open(l: &[char]) -> Option<(char, usize, String)> {
    let l = &l[spaces_upto3(l)..];
    let ch = *l.first()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let n = l.iter().take_while(|&&c| c == ch).count();
    if n < 3 || !l[n..].iter().all(|&c| dotable(c)) {
        return None;
    }
    Some((ch, n, chars_to_string(trim(&l[n..]))))
}

/// `^ {0,3}<ch>{<len>,}\s*$`
pub(super) fn fence_close(l: &[char], ch: char, len: usize) -> bool {
    let l = &l[spaces_upto3(l)..];
    let n = l.iter().take_while(|&&c| c == ch).count();
    n >= len && all_ws(&l[n..])
}

/// `^(#{1,6})\s+(.+?)(?:\s+#+\s*|\s*)$` -> (level, content).
pub(super) fn atx_heading(l: &[char]) -> Option<(usize, String)> {
    let h = l.iter().take_while(|&&c| c == '#').count();
    if h == 0 || h > 6 {
        return None;
    }
    let s = &l[h..];
    let w = ws_len(s);
    if w == 0 {
        return None;
    }
    for k in (1..=w).rev() {
        let r = &s[k..];
        for len in 1..=r.len() {
            if !dotable(r[len - 1]) {
                break;
            }
            if heading_tail(&r[len..]) {
                return Some((h, chars_to_string(&r[..len])));
            }
        }
    }
    None
}

/// `(?:\s+#+\s*|\s*)$`
fn heading_tail(t: &[char]) -> bool {
    let a = ws_len(t);
    if a > 0 {
        let rest = &t[a..];
        let b = rest.iter().take_while(|&&c| c == '#').count();
        if b > 0 && all_ws(&rest[b..]) {
            return true;
        }
    }
    all_ws(t)
}

/// `^(\s{0,3})([-*_])\s*(\2\s*){2,}$`
pub(super) fn is_hr(l: &[char]) -> bool {
    let m = ws_len(l);
    if m > 3 {
        return false;
    }
    let Some(&c) = l.get(m) else { return false };
    if !matches!(c, '-' | '*' | '_') {
        return false;
    }
    let rest = &l[m + 1..];
    rest.iter().all(|&x| x == c || is_js_ws(x)) && rest.iter().filter(|&&x| x == c).count() >= 2
}

/// `^={1,}\s*$`
pub(super) fn is_setext_eq(l: &[char]) -> bool {
    let n = l.iter().take_while(|&&c| c == '=').count();
    n >= 1 && all_ws(&l[n..])
}

/// `^[=-]+\s*$`
pub(super) fn is_setext_marker(l: &[char]) -> bool {
    let n = l.iter().take_while(|&&c| c == '=' || c == '-').count();
    n >= 1 && all_ws(&l[n..])
}

/// `^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$`
pub(super) fn is_table_separator(l: &[char]) -> bool {
    let mut p = ws_len(l);
    if l.get(p) == Some(&'|') {
        p += 1;
    }
    p += ws_len(&l[p..]);
    let cell = |mut p: usize| -> Option<usize> {
        if l.get(p) == Some(&':') {
            p += 1;
        }
        let d = l[p..].iter().take_while(|&&c| c == '-').count();
        if d == 0 {
            return None;
        }
        p += d;
        if l.get(p) == Some(&':') {
            p += 1;
        }
        Some(p + ws_len(&l[p..]))
    };
    let Some(mut p) = cell(p) else { return false };
    loop {
        if p >= l.len() {
            return true;
        }
        if l[p] != '|' {
            return false;
        }
        p += 1;
        p += ws_len(&l[p..]);
        if p >= l.len() {
            return true;
        }
        let Some(np) = cell(p) else { return false };
        p = np;
    }
}

/// `^\s{0,3}>`
pub(super) fn is_quote_start(l: &[char]) -> bool {
    let m = ws_len(l);
    m <= 3 && l.get(m) == Some(&'>')
}

/// `replace(/^\s{0,3}>\s?/, "")` for a line known to satisfy `is_quote_start`.
pub(super) fn strip_quote(l: &[char]) -> &[char] {
    let mut p = ws_len(l) + 1;
    if l.get(p).is_some_and(|&c| is_js_ws(c)) {
        p += 1;
    }
    &l[p..]
}

/// `^(#{1,6})\s`
pub(super) fn starts_heading(l: &[char]) -> bool {
    let h = l.iter().take_while(|&&c| c == '#').count();
    (1..=6).contains(&h) && l.get(h).is_some_and(|&c| is_js_ws(c))
}

/// `^(`{3,}|~{3,})`
pub(super) fn starts_fence(l: &[char]) -> bool {
    l.len() >= 3 && (l[..3] == ['`'; 3] || l[..3] == ['~'; 3])
}

/// Marker at `p`: `[-*+]|\d+[.)]`; returns the marker end.
fn marker_end(l: &[char], p: usize) -> Option<usize> {
    match l.get(p)? {
        '-' | '*' | '+' => Some(p + 1),
        c if c.is_ascii_digit() => {
            let d = l[p..].iter().take_while(|c| c.is_ascii_digit()).count();
            matches!(l.get(p + d), Some('.' | ')')).then_some(p + d + 1)
        }
        _ => None,
    }
}

/// `^\s*([-*+]|\d+[.)])\s+`
pub(super) fn has_list_prefix(l: &[char]) -> bool {
    marker_end(l, ws_len(l)).is_some_and(|e| l.get(e).is_some_and(|&c| is_js_ws(c)))
}

/// `^\s*\|(.+\|)+\s*$`
pub(super) fn is_table_row(l: &[char]) -> bool {
    let p = ws_len(l);
    if l.get(p) != Some(&'|') {
        return false;
    }
    let t = &l[p + 1..];
    let Some(last) = t.iter().rposition(|&c| c == '|') else {
        return false;
    };
    last >= 1 && t[..=last].iter().all(|&c| dotable(c)) && all_ws(&t[last + 1..])
}

pub(super) struct ListMatch {
    pub indent: usize,
    pub marker: String,
    pub marker_spaces: usize,
    pub checkbox: Option<char>,
    pub content: String,
}

/// `^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\] )?(.*)$`
pub(super) fn list_item(l: &[char]) -> Option<ListMatch> {
    let indent = ws_len(l);
    let me = marker_end(l, indent)?;
    let spaces = ws_len(&l[me..]);
    if spaces == 0 {
        return None;
    }
    let mut p = me + spaces;
    if !l[p..].iter().all(|&c| dotable(c)) {
        return None;
    }
    let mut checkbox = None;
    if l.get(p) == Some(&'[')
        && matches!(l.get(p + 1), Some(' ' | 'x' | 'X'))
        && l.get(p + 2) == Some(&']')
        && l.get(p + 3) == Some(&' ')
    {
        checkbox = Some(l[p + 1]);
        p += 4;
    }
    Some(ListMatch {
        indent,
        marker: chars_to_string(&l[indent..me]),
        marker_spaces: spaces,
        checkbox,
        content: chars_to_string(&l[p..]),
    })
}

const HTML_BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "audio",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "section",
    "source",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
];

fn starts_with_chars(l: &[char], s: &str) -> bool {
    let mut it = l.iter();
    s.chars().all(|c| it.next() == Some(&c))
}

pub(super) fn is_html_block_start(line: &[char]) -> bool {
    let l = &line[spaces_upto3(line)..];
    if l.first() != Some(&'<') {
        return false;
    }
    let r = &l[1..];
    if starts_with_chars(r, "!--")
        || starts_with_chars(r, "?")
        || starts_with_chars(r, "![CDATA[")
        || (r.first() == Some(&'!') && r.get(1).is_some_and(|c| c.is_ascii_alphabetic()))
    {
        return true;
    }
    let r = if r.first() == Some(&'/') { &r[1..] } else { r };
    if !r.first().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let n = r
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || **c == '-')
        .count();
    let after = &r[n..];
    let ok = after.is_empty()
        || is_js_ws(after[0])
        || after[0] == '>'
        || (after[0] == '/' && after.get(1) == Some(&'>'));
    ok && HTML_BLOCK_TAGS.contains(&chars_to_string(&r[..n]).to_ascii_lowercase().as_str())
}

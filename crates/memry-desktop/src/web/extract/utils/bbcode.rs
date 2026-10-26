//! `bbcodeToHtml` (`dist/utils/bbcode.js`): Steam and forum BBCode to HTML. Every pattern keeps
//! the JS flags `gi`; the `i` flag folds ASCII only.

use std::sync::LazyLock;

use regex::{Captures, Regex};

use super::dom::is_dangerous_url;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

/// `\[tag\]([\s\S]*?)\[\/tag\]` as a pair that wraps its text in `html_tag`.
fn pair(tag: &str) -> Regex {
    re(&format!(r"(?i-u:\[{tag}\])((?s:.)*?)(?i-u:\[/{tag}\])"))
}

struct Patterns {
    pairs: Vec<(Regex, &'static str, &'static str)>,
    url: Regex,
    img: Regex,
    preview_youtube: Regex,
    list: Regex,
    olist: Regex,
    quote: Regex,
    code: Regex,
    spoiler: Regex,
    paragraph: Regex,
    leftover: Regex,
}

static PATTERNS: LazyLock<Patterns> = LazyLock::new(|| Patterns {
    pairs: vec![
        (pair("h1"), "<h1>", "</h1>"),
        (pair("h2"), "<h2>", "</h2>"),
        (pair("h3"), "<h3>", "</h3>"),
        (pair("b"), "<strong>", "</strong>"),
        (pair("i"), "<em>", "</em>"),
        (pair("u"), "<u>", "</u>"),
        (pair("s"), "<s>", "</s>"),
    ],
    url: re(r#"(?i-u:\[url=)["']?([^"'\]]+)["']?\]((?s:.)*?)(?i-u:\[/url\])"#),
    img: pair("img"),
    preview_youtube: re(
        r#"(?i-u:\[previewyoutube=)["']?([^;'"]+)[^"'\]]*["']?\]\[(?i-u:/previewyoutube)\]"#,
    ),
    list: pair("list"),
    olist: pair("olist"),
    quote: re(r"(?i-u:\[quote)(?:=[^\]]+)?\]((?s:.)*?)(?i-u:\[/quote\])"),
    code: pair("code"),
    spoiler: pair("spoiler"),
    paragraph: pair("p"),
    leftover: re(r"\[[^\]]+\]"),
});

/// `inner.replace(/\[\*\]([\s\S]*?)(?=\[\*\]|\[\/list\]|$)/gi, '<li>$1</li>')`: `inner` holds no
/// closing tag, so an item runs to the next `[*]` or the end.
fn list_items(inner: &str) -> String {
    let mut out = String::new();
    let mut rest = inner;
    while let Some(i) = rest.find("[*]") {
        out.push_str(&rest[..i]);
        let item = &rest[i + 3..];
        let end = item.find("[*]").unwrap_or(item.len());
        out.push_str("<li>");
        out.push_str(&item[..end]);
        out.push_str("</li>");
        rest = &item[end..];
    }
    out.push_str(rest);
    out
}

pub fn bbcode_to_html(bbcode: &str) -> String {
    let p = &*PATTERNS;
    let mut html = bbcode.to_string();
    for (regex, open, close) in &p.pairs {
        html = regex
            .replace_all(&html, |c: &Captures| format!("{open}{}{close}", &c[1]))
            .into_owned();
    }
    html = p
        .url
        .replace_all(&html, |c: &Captures| {
            if is_dangerous_url(&c[1]) {
                c[2].to_string()
            } else {
                format!("<a href=\"{}\">{}</a>", &c[1], &c[2])
            }
        })
        .into_owned();
    html = p
        .img
        .replace_all(&html, |c: &Captures| format!("<img src=\"{}\">", &c[1]))
        .into_owned();
    html = p
        .preview_youtube
        .replace_all(&html, |c: &Captures| {
            format!("<img src=\"https://www.youtube.com/watch?v={}\">", &c[1])
        })
        .into_owned();
    html = p
        .list
        .replace_all(&html, |c: &Captures| {
            format!("<ul>{}</ul>", list_items(&c[1]))
        })
        .into_owned();
    html = p
        .olist
        .replace_all(&html, |c: &Captures| {
            format!("<ol>{}</ol>", list_items(&c[1]))
        })
        .into_owned();
    html = p
        .quote
        .replace_all(&html, |c: &Captures| {
            format!("<blockquote>{}</blockquote>", &c[1])
        })
        .into_owned();
    html = p
        .code
        .replace_all(&html, |c: &Captures| {
            format!("<pre><code>{}</code></pre>", &c[1])
        })
        .into_owned();
    html = p
        .spoiler
        .replace_all(&html, |c: &Captures| {
            format!("<details><summary>Spoiler</summary>{}</details>", &c[1])
        })
        .into_owned();
    html = p
        .paragraph
        .replace_all(&html, |c: &Captures| {
            format!("<p>{}</p>", c[1].replace('\n', "<br>"))
        })
        .into_owned();
    html = html.replace('\n', "<br>");
    p.leftover.replace_all(&html, "").into_owned()
}

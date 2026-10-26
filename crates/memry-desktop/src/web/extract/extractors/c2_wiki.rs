//! `dist/extractors/c2-wiki.js`: a page of the original wiki, rendered from its JSON source.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use url::Url;

use crate::web::extract::error::ExtractError;
use crate::web::extract::fetch::{FetchRequest, Fetcher};
use crate::web::extract::utils::dom::{escape_html, is_dangerous_url};
use crate::web::extract::utils::js::WS;
use crate::web::extract::utils::json::{JsValue, parse};

use super::base::{Cx, Extracted, Extractor, Variables};

const C2_API: &str = "https://c2.com/wiki/remodel/pages/";

pub struct C2WikiExtractor {
    /// `getPageTitle()`: the first query word, `WelcomeVisitors` without one, `None` for a URL
    /// that does not parse.
    page_title: Option<String>,
}

static QUERY_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[?&]([A-Za-z][A-Za-z0-9_]*)").expect("static"));
static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z])([A-Z])").expect("static"));
static BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^{WS}*$")).expect("static"));
static RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-----*").expect("static"));
static DL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\t+)([^\n\r\x{2028}\x{2029}]+):\t").expect("static"));
static TAB_UL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\t+)\*").expect("static"));
static STAR_UL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\*+)").expect("static"));
static OL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\t+)[0-9]+\.?").expect("static"));
static LEADING_WS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^{WS}")).expect("static"));
static STRONG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"'''([^\n\r\x{2028}\x{2029}]*?)'''").expect("static"));
static EM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"''([^\n\r\x{2028}\x{2029}]*?)''").expect("static"));
static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?-u:\b)(https?|ftp|mailto|file|telnet|news):[^{WS_BODY}<>\[\]"'()]*[^{WS_BODY}<>\[\]"'(),.?]"#,
        WS_BODY = crate::web::extract::utils::js::WS_BODY
    ))
    .expect("static")
});
static IMAGE_EXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:\.(gif|jpg|jpeg|png)$)").expect("static"));
static LINE_JOIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\\n").expect("static"));
static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").expect("static"));

impl C2WikiExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let page_title = Url::parse(cx.url).ok().map(|url| {
            let search = match url.query() {
                Some(q) if !q.is_empty() => format!("?{q}"),
                _ => String::new(),
            };
            QUERY_WORD
                .captures(&search)
                .map(|m| m[1].to_string())
                .unwrap_or_else(|| "WelcomeVisitors".to_string())
        });
        Ok(Self { page_title })
    }
}

fn escape_attr(text: &str) -> String {
    text.replace('"', "&quot;").replace('\'', "&#39;")
}

fn apply_inline(text: &str) -> String {
    let t = STRONG.replace_all(text, "<strong>$1</strong>");
    let t = EM.replace_all(&t, "<em>$1</em>");
    URL_RE
        .replace_all(&t, |m: &Captures| {
            let url = &m[0];
            if is_dangerous_url(url) {
                escape_html(url)
            } else if IMAGE_EXT.is_match(url) {
                format!("<img src=\"{}\">", escape_attr(url))
            } else {
                format!(
                    "<a href=\"{}\" rel=\"nofollow\" target=\"_blank\">{}</a>",
                    escape_attr(url),
                    escape_html(url)
                )
            }
        })
        .into_owned()
}

/// `applyBullets(text, openTags)`: the line's HTML and the tags still open.
fn apply_bullets(text: &str, open_tags: &[&'static str]) -> (String, Vec<&'static str>) {
    let mut open: Vec<&'static str> = open_tags.to_vec();
    let mut prefix = String::new();
    fn close_to_depth(
        open: &mut Vec<&'static str>,
        prefix: &mut String,
        depth: usize,
        tag: Option<&'static str>,
    ) {
        while open.len() > depth {
            prefix.push_str(&format!("</{}>", open.pop().unwrap_or_default()));
        }
        let Some(tag) = tag else { return };
        if open.len() < depth {
            prefix.push_str(&format!("<{tag}>"));
            open.push(tag);
        } else if open.len() == depth && open.get(depth.wrapping_sub(1)) != Some(&tag) {
            prefix.push_str(&format!("</{}><{tag}>", open.pop().unwrap_or_default()));
            open.push(tag);
        }
    }
    if BLANK.is_match(text) {
        if open.iter().any(|t| matches!(*t, "ul" | "ol" | "dl")) {
            return (String::new(), open);
        }
        close_to_depth(&mut open, &mut prefix, 0, None);
        return (format!("{prefix}<p></p>"), open);
    }
    if RULE.is_match(text) {
        close_to_depth(&mut open, &mut prefix, 0, None);
        return (format!("{prefix}<hr>"), open);
    }
    if let Some(m) = DL.captures(text) {
        close_to_depth(&mut open, &mut prefix, m[1].len(), Some("dl"));
        return (
            format!("{prefix}<dt>{}<dd>{}", &m[2], &text[m[0].len()..]),
            open,
        );
    }
    for (re, tag) in [(&*TAB_UL, "ul"), (&*STAR_UL, "ul"), (&*OL, "ol")] {
        if let Some(m) = re.captures(text) {
            close_to_depth(&mut open, &mut prefix, m[1].len(), Some(tag));
            return (format!("{prefix}<li>{}", &text[m[0].len()..]), open);
        }
    }
    if LEADING_WS.is_match(text) {
        close_to_depth(&mut open, &mut prefix, 1, Some("pre"));
        return (format!("{prefix}{text}"), open);
    }
    close_to_depth(&mut open, &mut prefix, 0, None);
    (format!("{prefix}{text}"), open)
}

fn markup(text: &str) -> String {
    let joined = LINE_JOIN.replace_all(text, " ");
    let mut parts = Vec::new();
    let mut open: Vec<&'static str> = Vec::new();
    for line in LINES.split(&joined) {
        let (html, next) = apply_bullets(line, &open);
        parts.push(apply_inline(&html));
        open = next;
    }
    while let Some(tag) = open.pop() {
        parts.push(format!("</{tag}>"));
    }
    parts.join("\n")
}

impl Extractor for C2WikiExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(false)
    }

    fn extract(&mut self, _cx: &mut Cx) -> Result<Extracted, ExtractError> {
        Ok(Extracted::default())
    }

    fn can_extract_async(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.page_title.is_some())
    }

    fn prefers_async(&self) -> bool {
        true
    }

    fn extract_async(
        &mut self,
        _cx: &mut Cx,
        fetcher: &dyn Fetcher,
    ) -> Result<Extracted, ExtractError> {
        let Some(title) = self.page_title.clone().filter(|t| !t.is_empty()) else {
            return Ok(Extracted::default());
        };
        let response = fetcher
            .fetch(FetchRequest {
                url: format!("{C2_API}{title}"),
                method: "GET".into(),
                headers: Vec::new(),
                body: None,
            })
            .map_err(ExtractError::Js)?;
        let json = parse(&response.text).map_err(ExtractError::Js)?;
        let Some(text) = json.get("text").filter(|t| t.truthy()) else {
            return Ok(Extracted::default());
        };
        let date = json
            .get("date")
            .filter(|d| d.truthy())
            .map(JsValue::to_js_string)
            .unwrap_or_default();
        let body = markup(&text.to_js_string());
        let footer = if date.is_empty() {
            String::new()
        } else {
            format!("<hr><p>Last edit {}</p>", escape_html(&date))
        };
        Ok(Extracted {
            content_html: format!("{body}{footer}"),
            content_selector: None,
            variables: Variables {
                title: CAMEL.replace_all(&title, "$1 $2").into_owned(),
                site: "C2 Wiki".into(),
                published: date,
                ..Variables::default()
            },
        })
    }
}

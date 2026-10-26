//! `dist/extractors/substack.js`: posts (rendered body, or `body_html` injected from the
//! preload script) and notes.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, parse_float, trim};
use crate::web::extract::utils::json::{JsValue, parse};

use super::base::{Cx, Extracted, Extractor, Variables, attr_of, sel_attr, sel_text, text_of};

const INJECTED_ATTR: &str = "data-defuddle-substack-post";

pub struct SubstackExtractor {
    note_text: Option<NodeId>,
    note_image: Option<NodeId>,
    post_data: Option<JsValue>,
    post_selector: Option<String>,
}

/// `extractPreloadData()`: the post inside `JSON.parse("...")` of `window._preloads`.
fn extract_preload_data(cx: &Cx) -> Result<Option<JsValue>, ExtractError> {
    const MARKER: &str = "JSON.parse(\"";
    for script in cx.qsa("script")? {
        let text = text_of(cx.doc, script);
        if !text.contains("window._preloads") || !text.contains("body_html") {
            continue;
        }
        let Some(at) = text.find(MARKER) else {
            continue;
        };
        let start = at + MARKER.len();
        let bytes = text.as_bytes();
        let mut i = start;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' => i += 2,
                b'"' => break,
                _ => i += 1,
            }
        }
        let inner = &text[start..i.min(text.len())];
        let Ok(JsValue::String(json)) = parse(&format!("\"{inner}\"")) else {
            continue;
        };
        let Ok(data) = parse(&json) else { continue };
        let post = data
            .get("feedData")
            .and_then(|d| d.get("initialPost"))
            .and_then(|d| d.get("post"))
            .filter(|p| p.get("body_html").is_some_and(JsValue::truthy));
        if let Some(post) = post {
            return Ok(Some(post.clone()));
        }
    }
    Ok(None)
}

static ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"([^\n\r\x{{2028}}\x{{2029}}]+?){WS}+([0-9]+(?:\.[0-9]+)?)w"
    ))
    .expect("static")
});
static CDN_WIDTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",w_[0-9]+").expect("static"));
static CDN_CROP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r",c_[A-Za-z0-9_]+").expect("static"));

/// `getLargestSrc(img)`.
fn largest_src(cx: &Cx, img: NodeId) -> String {
    let srcset = attr_of(cx.doc, img, "srcset");
    if !srcset.is_empty() {
        let (mut best_url, mut best_width) = (String::new(), 0.0);
        let mut last_end = 0;
        for m in ENTRY.captures_iter(&srcset) {
            let mut url = trim(&m[1]).to_string();
            if last_end > 0 {
                url = url
                    .strip_prefix(',')
                    .map(|u| {
                        u.trim_start_matches(crate::web::extract::utils::js::is_js_whitespace)
                            .to_string()
                    })
                    .unwrap_or(url);
            }
            last_end = m.get(0).map_or(0, |g| g.end());
            let width = parse_float(&m[2]).unwrap_or(f64::NAN);
            if !url.is_empty() && width > best_width {
                best_width = width;
                best_url = url;
            }
        }
        if !best_url.is_empty() {
            return CDN_CROP
                .replace_all(&CDN_WIDTH.replace_all(&best_url, ""), "")
                .into_owned();
        }
    }
    attr_of(cx.doc, img, "src")
}

impl SubstackExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let mut this = Self {
            note_text: None,
            note_image: None,
            post_data: None,
            post_selector: None,
        };
        if cx.qs("div.body.markup")?.is_some() {
            this.post_data = extract_preload_data(cx)?;
            this.post_selector = Some("div.body.markup".into());
            return Ok(this);
        }
        this.post_data = extract_preload_data(cx)?;
        if let Some(body_html) = this
            .post_data
            .as_ref()
            .and_then(|p| p.get("body_html"))
            .filter(|b| b.truthy())
        {
            let selector = format!("[{INJECTED_ATTR}]");
            if cx.qs(&selector)?.is_none() {
                let wrapper = cx.doc.create_element("div");
                cx.doc.set_attribute(wrapper, INJECTED_ATTR, "");
                let fragment = cx.doc.parse_fragment(&body_html.to_js_string());
                cx.doc.append_child(wrapper, fragment)?;
                let root = cx.root;
                let body = cx
                    .doc
                    .body_of(root)
                    .ok_or_else(|| ExtractError::Js("TypeError: document.body is null".into()))?;
                cx.doc.append_child(body, wrapper)?;
            }
            this.post_selector = Some(selector);
            return Ok(this);
        }
        let scope = cx.qs(r#"[class*="feedPermalinkUnit"]"#)?.unwrap_or(cx.root);
        this.note_text = cx
            .doc
            .query_selector(scope, "div.ProseMirror.FeedProseMirror")?;
        if let Some(note) = this.note_text
            && let Some(body) = cx.doc.closest(
                note,
                r#"[class*="feedCommentBody"]:not([class*="feedCommentBodyInner"])"#,
            )?
        {
            let parent_next = match cx.doc.parent_element(body) {
                Some(p) => cx.doc.next_element_sibling(p),
                None => None,
            };
            for candidate in [cx.doc.next_element_sibling(body), parent_next]
                .into_iter()
                .flatten()
            {
                if attr_of(cx.doc, candidate, "class").contains("imageGrid") {
                    this.note_image = Some(candidate);
                    break;
                }
            }
        }
        Ok(this)
    }

    fn published_from_byline(cx: &Cx) -> Result<String, ExtractError> {
        let Some(byline) = cx.qs(r#"[class*="byline-wrapper"]"#)? else {
            return Ok(String::new());
        };
        static CASE_BOUNDARY: LazyLock<Regex> =
            LazyLock::new(|| Regex::new("([a-z])([A-Z])").expect("static"));
        static DATE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(&format!(
                r"(?-u:\b)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec){WS}+([0-9]{{1,2}}),?{WS}+([0-9]{{4}})(?-u:\b)"
            ))
            .expect("static")
        });
        let text = CASE_BOUNDARY
            .replace_all(trim(&text_of(cx.doc, byline)), "${1} ${2}")
            .into_owned();
        let Some(m) = DATE.captures(&text) else {
            return Ok(String::new());
        };
        let month = match &m[1] {
            "Jan" => "01",
            "Feb" => "02",
            "Mar" => "03",
            "Apr" => "04",
            "May" => "05",
            "Jun" => "06",
            "Jul" => "07",
            "Aug" => "08",
            "Sep" => "09",
            "Oct" => "10",
            "Nov" => "11",
            _ => "12",
        };
        Ok(format!("{}-{month}-{:0>2}T00:00:00+00:00", &m[3], &m[2]))
    }

    fn image_html(&self, cx: &Cx) -> Result<String, ExtractError> {
        let Some(grid) = self.note_image else {
            return Ok(String::new());
        };
        let og = sel_attr(cx.doc, cx.root, r#"meta[property="og:image"]"#, "content")?;
        if !og.is_empty() {
            return Ok(format!("<img src=\"{og}\" alt=\"\" />"));
        }
        let Some(img) = cx.doc.query_selector(grid, "img")? else {
            return Ok(String::new());
        };
        let src = largest_src(cx, img);
        Ok(if src.is_empty() {
            String::new()
        } else {
            format!("<img src=\"{src}\" alt=\"\" />")
        })
    }

    fn or_meta(cx: &Cx, value: Option<&JsValue>, property: &str) -> Result<String, ExtractError> {
        match value.filter(|v| v.truthy()) {
            Some(v) => Ok(v.to_js_string()),
            None => sel_attr(
                cx.doc,
                cx.root,
                &format!(r#"meta[property="{property}"]"#),
                "content",
            ),
        }
    }
}

impl Extractor for SubstackExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.post_selector.is_some() || self.note_text.is_some())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        if let Some(selector) = self.post_selector.clone() {
            let data = self.post_data.as_ref();
            let title = Self::or_meta(cx, data.and_then(|p| p.get("title")), "og:title")?;
            let description =
                Self::or_meta(cx, data.and_then(|p| p.get("subtitle")), "og:description")?;
            let byline = data
                .and_then(|p| p.get("publishedBylines"))
                .and_then(|b| match b {
                    JsValue::Array(items) => items.first(),
                    _ => None,
                })
                .and_then(|b| b.get("name"))
                .filter(|n| n.truthy())
                .map(JsValue::to_js_string);
            let author = match byline {
                Some(name) => name,
                None => sel_text(cx.doc, cx.root, r#"a[href*="substack.com/@"]"#)?,
            };
            let published = match data.and_then(|p| p.get("post_date")).filter(|d| d.truthy()) {
                Some(d) => d.to_js_string(),
                None => Self::published_from_byline(cx)?,
            };
            return Ok(Extracted {
                content_html: String::new(),
                content_selector: Some(selector),
                variables: Variables {
                    title,
                    author,
                    site: "Substack".into(),
                    description,
                    published,
                    ..Variables::default()
                },
            });
        }
        let note = self
            .note_text
            .ok_or_else(|| ExtractError::Js("TypeError: noteText is null".into()))?;
        let text_html = cx.doc.outer_html(note);
        let image_html = self.image_html(cx)?;
        let content = if image_html.is_empty() {
            text_html
        } else {
            format!("{text_html}\n{image_html}")
        };
        let title = sel_attr(cx.doc, cx.root, r#"meta[property="og:title"]"#, "content")?;
        let description = sel_attr(
            cx.doc,
            cx.root,
            r#"meta[property="og:description"]"#,
            "content",
        )?;
        static HANDLE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(&format!(r"{WS}*\(@[^)]+\){WS}*$")).expect("static"));
        let author = trim(&HANDLE.replace(&title, "")).to_string();
        Ok(Extracted {
            content_html: content,
            content_selector: None,
            variables: Variables {
                title,
                author,
                site: "Substack".into(),
                description,
                ..Variables::default()
            },
        })
    }
}

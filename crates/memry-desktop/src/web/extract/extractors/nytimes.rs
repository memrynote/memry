//! `dist/extractors/nytimes.js`: the article body is JSON in `window.__preloadedData`. The
//! constructor renders it into a `<div data-defuddle-nyt>` appended to the live page, and
//! `extract` points Defuddle's pipeline at it.

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::is_js_whitespace;
use crate::web::extract::utils::json::{JsValue, parse};

use super::base::{Cx, Extracted, Extractor, Variables, text_of};

const INJECTED_ATTR: &str = "data-defuddle-nyt";

pub struct NytimesExtractor {
    data: Option<JsValue>,
    content_selector: Option<String>,
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `value || ''` for a value used as a string; any other truthy type throws in JS (`replace`
/// is not a function).
fn text_value(value: Option<&JsValue>) -> Result<String, ExtractError> {
    match value {
        None => Ok(String::new()),
        Some(JsValue::String(s)) => Ok(s.clone()),
        Some(v) if !v.truthy() => Ok(String::new()),
        Some(_) => Err(ExtractError::Js(
            "TypeError: text.replace is not a function".into(),
        )),
    }
}

/// `raw.replace(/(?<=:)undefined(?=[,}\]])/g, 'null')`.
fn replace_undefined(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last = 0;
    let mut from = 0;
    while let Some(i) = raw[from..].find("undefined") {
        let at = from + i;
        let end = at + "undefined".len();
        let before_ok = raw[..at].ends_with(':');
        let after_ok = raw[end..].starts_with([',', '}', ']']);
        if before_ok && after_ok {
            out.push_str(&raw[last..at]);
            out.push_str("null");
            last = end;
            from = end;
        } else {
            from = at + 1;
        }
    }
    out.push_str(&raw[last..]);
    out
}

/// The `{...}` of `/window\.__preloadedData\s*=\s*({[\s\S]+})\s*;?\s*$/`, which runs to the last
/// closing brace of the script.
fn preloaded_json(text: &str) -> Option<&str> {
    const MARKER: &str = "window.__preloadedData";
    let mut from = 0;
    while let Some(i) = text[from..].find(MARKER) {
        let at = from + i;
        from = at + 1;
        let rest = text[at + MARKER.len()..].trim_start_matches(is_js_whitespace);
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start_matches(is_js_whitespace);
        if !rest.starts_with('{') {
            continue;
        }
        let tail = rest.trim_end_matches(is_js_whitespace);
        let tail = tail
            .strip_suffix(';')
            .map_or(tail, |t| t.trim_end_matches(is_js_whitespace));
        if tail.len() >= 3 && tail.ends_with('}') {
            return Some(tail);
        }
    }
    None
}

fn extract_preload_data(cx: &Cx) -> Result<Option<JsValue>, ExtractError> {
    for script in cx.qsa("script:not([src])")? {
        let text = text_of(cx.doc, script);
        if !text.contains("window.__preloadedData") {
            continue;
        }
        let Some(json) = preloaded_json(&text) else {
            continue;
        };
        let Ok(data) = parse(&replace_undefined(json)) else {
            return Ok(None);
        };
        let article = data
            .get("initialData")
            .and_then(|d| d.get("data"))
            .and_then(|d| d.get("article"))
            .filter(|a| a.truthy())
            .cloned();
        return Ok(article);
    }
    Ok(None)
}

fn render_inlines(inlines: Option<&JsValue>) -> Result<String, ExtractError> {
    let Some(inlines) = inlines.filter(|v| v.truthy()) else {
        return Ok(String::new());
    };
    let JsValue::Array(items) = inlines else {
        return Err(ExtractError::Js(
            "TypeError: inlines.map is not a function".into(),
        ));
    };
    let mut out = String::new();
    for inline in items {
        let mut text = escape_html(&text_value(inline.get("text"))?);
        if let Some(JsValue::Array(formats)) = inline.get("formats") {
            for fmt in formats {
                match fmt.get("__typename").and_then(JsValue::as_str) {
                    Some("BoldFormat") => text = format!("<strong>{text}</strong>"),
                    Some("ItalicFormat") => text = format!("<em>{text}</em>"),
                    Some("LinkFormat") => {
                        if let Some(url) = fmt.get("url").filter(|u| u.truthy()) {
                            text = format!(
                                "<a href=\"{}\">{text}</a>",
                                escape_attr(&url.to_js_string())
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        out.push_str(&text);
    }
    Ok(out)
}

fn best_image_url(media: &JsValue) -> Option<String> {
    let JsValue::Array(crops) = media.get("crops")? else {
        return None;
    };
    for name in ["superJumbo", "jumbo", "articleLarge"] {
        for crop in crops {
            let Some(JsValue::Array(renditions)) = crop.get("renditions") else {
                continue;
            };
            let found = renditions
                .iter()
                .find(|r| r.get("name").and_then(JsValue::as_str) == Some(name));
            if let Some(url) = found.and_then(|r| r.get("url")).filter(|u| u.truthy()) {
                return Some(url.to_js_string());
            }
        }
    }
    for crop in crops {
        if let Some(JsValue::Array(renditions)) = crop.get("renditions")
            && let Some(url) = renditions
                .first()
                .and_then(|r| r.get("url"))
                .filter(|u| u.truthy())
        {
            return Some(url.to_js_string());
        }
    }
    None
}

fn render_blocks(blocks: &[JsValue]) -> Result<String, ExtractError> {
    let mut parts = Vec::new();
    for block in blocks {
        if matches!(block, JsValue::Null) {
            return Err(ExtractError::Js("TypeError: block is null".into()));
        }
        let typename = block
            .get("__typename")
            .and_then(JsValue::as_str)
            .unwrap_or_default();
        match typename {
            "ParagraphBlock" => {
                parts.push(format!("<p>{}</p>", render_inlines(block.get("content"))?))
            }
            "Heading2Block" => parts.push(format!(
                "<h2>{}</h2>",
                render_inlines(block.get("content"))?
            )),
            "Heading3Block" => parts.push(format!(
                "<h3>{}</h3>",
                render_inlines(block.get("content"))?
            )),
            "Heading4Block" => parts.push(format!(
                "<h4>{}</h4>",
                render_inlines(block.get("content"))?
            )),
            "ImageBlock" => {
                let Some(media) = block.get("media").filter(|m| m.truthy()) else {
                    continue;
                };
                let Some(src) = best_image_url(media) else {
                    continue;
                };
                let caption_text = media.get("caption").and_then(|c| c.get("text"));
                let alt_text = text_value(media.get("altText"))?;
                let alt = if alt_text.is_empty() {
                    text_value(caption_text)?
                } else {
                    alt_text
                };
                let alt = escape_attr(&alt);
                let caption = text_value(caption_text)?;
                let credit = text_value(media.get("credit"))?;
                let figcaption: Vec<&str> = [caption.as_str(), credit.as_str()]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect();
                if figcaption.is_empty() {
                    parts.push(format!("<img src=\"{}\" alt=\"{alt}\">", escape_attr(&src)));
                } else {
                    parts.push(format!(
                        "<figure><img src=\"{}\" alt=\"{alt}\"><figcaption>{}</figcaption></figure>",
                        escape_attr(&src),
                        escape_html(&figcaption.join(" "))
                    ));
                }
            }
            "HeaderBasicBlock" | "Dropzone" => {}
            _ => {
                if let Some(content) = block.get("content")
                    && matches!(content, JsValue::Array(a) if !a.is_empty())
                {
                    parts.push(format!("<p>{}</p>", render_inlines(Some(content))?));
                }
            }
        }
    }
    Ok(parts.join("\n"))
}

impl NytimesExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let data = extract_preload_data(cx)?;
        let mut content_selector = None;
        if let Some(article) = &data {
            let body = article
                .get("sprinkledBody")
                .filter(|b| b.truthy())
                .or_else(|| article.get("body"));
            if let Some(content) = body.and_then(|b| b.get("content")) {
                let blocks = match content {
                    JsValue::Array(items) if !items.is_empty() => Some(items.as_slice()),
                    JsValue::String(s) if !s.is_empty() => Some(&[][..]),
                    _ => None,
                };
                if let Some(blocks) = blocks {
                    let attr_selector = format!("[{INJECTED_ATTR}]");
                    if cx.qs(&attr_selector)?.is_none() {
                        let wrapper = cx.doc.create_element("div");
                        cx.doc.set_attribute(wrapper, INJECTED_ATTR, "");
                        let fragment = cx.doc.parse_fragment(&render_blocks(blocks)?);
                        cx.doc.append_child(wrapper, fragment)?;
                        let root = cx.root;
                        let body = cx.doc.body_of(root).ok_or_else(|| {
                            ExtractError::Js("TypeError: document.body is null".into())
                        })?;
                        cx.doc.append_child(body, wrapper)?;
                    }
                    content_selector = Some(attr_selector);
                }
            }
        }
        Ok(Self {
            data,
            content_selector,
        })
    }
}

impl Extractor for NytimesExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.content_selector.is_some())
    }

    fn extract(&mut self, _cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let article = self.data.clone().unwrap_or(JsValue::Null);
        let title = text_value(article.get("headline").and_then(|h| h.get("default")))?;
        let creators = article
            .get("bylines")
            .and_then(|b| match b {
                JsValue::Array(items) => items.first(),
                _ => None,
            })
            .and_then(|b| b.get("creators"));
        let mut names = Vec::new();
        if let Some(JsValue::Array(items)) = creators {
            for creator in items {
                if let Some(name) = creator.get("displayName").filter(|n| n.truthy()) {
                    names.push(name.to_js_string());
                }
            }
        }
        Ok(Extracted {
            content_html: String::new(),
            content_selector: self.content_selector.clone(),
            variables: Variables {
                title,
                author: names.join(", "),
                published: text_value(article.get("firstPublished"))?,
                description: text_value(article.get("summary"))?,
                ..Variables::default()
            },
        })
    }
}

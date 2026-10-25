//! URL resolution and the sanitizing paths of `Defuddle` (`resolveRelativeUrls`,
//! `_stripUnsafeElements`, `_serializeFallbackBody`).

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{is_js_whitespace, split_whitespace_runs, trim};

use super::Defuddle;
use super::images::strip_leading_comma;

const WS_CLASS: &str = r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";

/// `/(.+?)\s+(\d+(?:\.\d+)?[wx])/g`: srcset entries end at their width or density descriptor,
/// since CDN URLs hold commas.
static SRCSET_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"([^\n\r\x{{2028}}\x{{2029}}]+?){WS_CLASS}+([0-9]+(?:\.[0-9]+)?[wx])"
    ))
    .expect("static pattern")
});
static LEADING_QUOTES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\\?["']+"#).expect("static pattern"));
static TRAILING_QUOTES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\\?["']+$"#).expect("static pattern"));

/// `isDangerousUrl(url)`: `javascript:` and `data:text/html`, whitespace and control characters
/// stripped first.
pub(super) fn is_dangerous_url(url: &str) -> bool {
    let normalized: String = url
        .chars()
        .filter(|&c| !is_js_whitespace(c) && c > '\u{1f}')
        .collect::<String>()
        .to_lowercase();
    normalized.starts_with("javascript:") || normalized.starts_with("data:text/html")
}

/// `_stripUnsafeElements(body)`: dangerous elements, event handlers, `srcdoc` and dangerous
/// URIs. Iframes stay (their attributes are cleaned here); math scripts stay for LaTeX.
pub(super) fn strip_unsafe_elements(
    doc: &mut Document,
    body: Option<NodeId>,
) -> Result<(), ExtractError> {
    let Some(body) = body else {
        return Ok(());
    };
    for el in doc.query_selector_all(
        body,
        r#"script:not([type^="math/"]), style, noscript, frame, frameset, object, embed, applet, base"#,
    )? {
        doc.remove(el);
    }
    for el in doc.query_selector_all(body, "*")? {
        let attributes: Vec<(String, String)> = doc
            .attributes(el)
            .iter()
            .map(|a| (a.name.clone(), a.value.clone()))
            .collect();
        for (name, value) in attributes {
            let lower = name.to_lowercase();
            let remove = lower.starts_with("on")
                || lower == "srcdoc"
                || (["href", "src", "action", "formaction", "xlink:href"]
                    .contains(&lower.as_str())
                    && is_dangerous_url(&value));
            if remove {
                doc.remove_attribute(el, &name);
            }
        }
    }
    Ok(())
}

/// The `resolve` closure of `resolveRelativeUrls`.
fn resolve(url: &str, base: &str) -> String {
    let trimmed = trim(url);
    let leading = LEADING_QUOTES.replace(trimmed, "");
    let normalized = TRAILING_QUOTES.replace(&leading, "").into_owned();
    // Fragment-only hrefs point into the same document.
    if normalized.starts_with('#') {
        return normalized;
    }
    match Url::parse(base).and_then(|b| b.join(&normalized)) {
        Ok(resolved) => resolved.to_string(),
        Err(_) => {
            if normalized.is_empty() {
                url.to_string()
            } else {
                normalized
            }
        }
    }
}

fn resolve_srcset(srcset: &str, base: &str) -> String {
    let mut entries = Vec::new();
    let mut last_end = 0;
    for entry in SRCSET_ENTRY.captures_iter(srcset) {
        let mut url = trim(&entry[1]).to_string();
        if last_end > 0 {
            url = strip_leading_comma(&url);
        }
        last_end = entry.get(0).expect("group 0").end();
        entries.push(format!("{} {}", resolve(&url, base), &entry[2]));
    }
    if !entries.is_empty() {
        return entries.join(", ");
    }
    // No descriptors: a plain comma split.
    srcset
        .split(',')
        .map(|entry| {
            let mut parts: Vec<String> = split_whitespace_runs(trim(entry))
                .into_iter()
                .map(str::to_string)
                .collect();
            if !parts[0].is_empty() {
                parts[0] = resolve(&parts[0], base);
            }
            parts.join(" ")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

impl Defuddle {
    /// `resolveRelativeUrls(element)`: `href`, `src`, `srcset` and `poster` become absolute,
    /// against `<base href>` when the page has one.
    pub(crate) fn resolve_relative_urls(&mut self, element: NodeId) -> Result<(), ExtractError> {
        if self.url.is_empty() {
            return Ok(());
        }
        let mut base = self.url.clone();
        if let Some(base_el) = self.doc.query_selector(self.root, "base[href]")? {
            let href = self
                .doc
                .get_attribute(base_el, "href")
                .map(|v| v.into_owned())
                .unwrap_or_default();
            if !href.is_empty()
                && let Ok(joined) = Url::parse(&self.url).and_then(|b| b.join(&href))
            {
                base = joined.to_string();
            }
        }
        for (selector, name) in [("[href]", "href"), ("[src]", "src")] {
            for el in self.doc.query_selector_all(element, selector)? {
                let value = self.doc.get_attribute(el, name).map(|v| v.into_owned());
                if let Some(value) = value.filter(|v| !v.is_empty()) {
                    self.doc.set_attribute(el, name, &resolve(&value, &base));
                }
            }
        }
        for el in self.doc.query_selector_all(element, "[srcset]")? {
            let value = self.doc.get_attribute(el, "srcset").map(|v| v.into_owned());
            if let Some(value) = value.filter(|v| !v.is_empty()) {
                self.doc
                    .set_attribute(el, "srcset", &resolve_srcset(&value, &base));
            }
        }
        for el in self.doc.query_selector_all(element, "[poster]")? {
            let value = self.doc.get_attribute(el, "poster").map(|v| v.into_owned());
            if let Some(value) = value.filter(|v| !v.is_empty()) {
                self.doc
                    .set_attribute(el, "poster", &resolve(&value, &base));
            }
        }
        Ok(())
    }

    /// `_serializeFallbackBody()`: the sanitized body of a clone, URLs resolved, for pages where
    /// extraction found nothing or failed.
    pub(crate) fn serialize_fallback_body(&mut self) -> Result<String, ExtractError> {
        let root = self.root;
        let Some(body) = self.doc.body_of(root) else {
            return Ok(String::new());
        };
        let safe = self.doc.clone_node(body, true);
        strip_unsafe_elements(&mut self.doc, Some(safe))?;
        let html = self.doc.inner_html(safe);
        self.resolve_content_urls(&html)
    }

    /// `resolveContentUrls(html)`.
    fn resolve_content_urls(&mut self, html: &str) -> Result<String, ExtractError> {
        if self.url.is_empty() {
            return Ok(html.to_string());
        }
        let container = self.doc.create_element("div");
        let fragment = self.doc.parse_fragment(html);
        self.doc.append_child(container, fragment)?;
        self.resolve_relative_urls(container)?;
        Ok(self.doc.inner_html(container))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_urls() {
        assert!(is_dangerous_url(" java\tscript:alert(1)"));
        assert!(is_dangerous_url("DATA:text/html;base64,xx"));
        assert!(!is_dangerous_url("data:image/png;base64,xx"));
        assert!(!is_dangerous_url("https://a.com"));
    }

    #[test]
    fn resolves_like_new_url() {
        let base = "https://a.com/dir/page";
        assert_eq!(resolve("img.png", base), "https://a.com/dir/img.png");
        assert_eq!(resolve("#top", base), "#top");
        assert_eq!(resolve("\\\"mailto:x@y.z\\\"", base), "mailto:x@y.z");
        assert_eq!(resolve("//cdn.com/x", base), "https://cdn.com/x");
        assert_eq!(resolve("", base), "https://a.com/dir/page");
    }

    #[test]
    fn srcset_entries_end_at_descriptors() {
        let base = "https://a.com/";
        assert_eq!(
            resolve_srcset("a.jpg 1x, /b,w_2/c.jpg 2x", base),
            "https://a.com/a.jpg 1x, https://a.com/b,w_2/c.jpg 2x"
        );
        assert_eq!(
            resolve_srcset("a.jpg, b.jpg", base),
            "https://a.com/a.jpg, https://a.com/b.jpg"
        );
    }
}

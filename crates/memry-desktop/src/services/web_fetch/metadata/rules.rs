//! The rules of the eight metascraper 5.49.21 bundles Electron loads (`metadata.ts:12-31`), in
//! the order of each package's `src/index.js`. A property takes the first rule whose mapped value
//! is a non-empty string (`findRule` with `has`).
//!
//! The author bundle wraps five rules in `strict`, which tests `/^\S+\s+\S+/` against the rule's
//! return value. That value is a promise, whose string `[object Promise]` always passes, so
//! `strict` never rejects anything and the rules here run without it.

use chrono::{DateTime, TimeZone};

use super::date::date;
use super::jsonld::{get, lookup};
use super::select::{Attr, Compound, Page, Sel};
use super::text::{self, condense};
use super::url::{image, url};
use crate::web::extract::utils::json::JsValue;

pub struct Ctx<'a, Tz: TimeZone> {
    pub page: &'a Page,
    pub items: &'a [JsValue],
    pub url: &'a str,
    pub now: &'a DateTime<Tz>,
}

type Rule<'r> = &'r dyn Fn() -> Option<String>;

/// `findRule`: the first rule giving a non-empty string.
fn first(rules: &[Rule]) -> Option<String> {
    rules
        .iter()
        .find_map(|rule| rule().filter(|value| !value.is_empty()))
}

macro_rules! sel {
    ($($tag:expr => [$($attr:expr),*]),+) => {
        Sel(&[$(Compound($tag, &[$($attr),*])),+])
    };
}

use Attr::{Class, Contains, Eq, Exists, NotEq};

/// `meta[<attr>="<value>"]`
macro_rules! meta {
    ($attr:literal, $value:literal) => {
        sel!(Some("meta") => [Eq($attr, $value, false)])
    };
}

impl<Tz: TimeZone> Ctx<'_, Tz> {
    fn attr(&self, sel: Sel, name: &str) -> Option<String> {
        self.page.attr(sel, name)
    }

    fn content(&self, sel: Sel) -> Option<String> {
        self.attr(sel, "content")
    }

    /// `$filter($, $(selector), fn)`: the first truthy `fn(element)`.
    fn filter_by(&self, sel: Sel, keep: impl Fn(String) -> Option<String>) -> Option<String> {
        for index in self.page.select(sel) {
            let found = keep(condense(&self.page.text(index)?));
            if found.as_ref().is_some_and(|v| !v.is_empty()) {
                return found;
            }
        }
        None
    }

    /// `$filter($, $(selector))`: the first non-empty condensed text.
    fn filter(&self, sel: Sel) -> Option<String> {
        self.filter_by(sel, Some)
    }

    /// `$filter($, $(selector), el => el.attr('src'))`.
    fn filter_src(&self, sel: Sel) -> Option<String> {
        self.page.select(sel).into_iter().find_map(|index| {
            self.page
                .attr_of(index, "src")
                .filter(|src| !src.is_empty())
                .map(str::to_owned)
        })
    }

    fn jsonld(&self, path: &str) -> Option<JsValue> {
        lookup(self.items, path)
    }

    /// `$jsonld(path)` for the mappers that take only strings.
    fn jsonld_str(&self, path: &str) -> Option<String> {
        match self.jsonld(path)? {
            JsValue::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn author(&self) -> Option<String> {
        let to = |value: Option<String>| value.and_then(|v| text::author(&v));
        let byline = sel!(None => [Contains("class", "byline")]);
        first(&[
            &|| to(self.jsonld_str("author.name")),
            &|| to(self.jsonld_str("brand.name")),
            &|| to(self.content(meta!("name", "author"))),
            &|| to(self.content(meta!("property", "article:author"))),
            &|| {
                to(self.filter(sel!(None => [Contains("itemprop", "author")], None => [Eq("itemprop", "name", false)])))
            },
            &|| to(self.filter(sel!(None => [Contains("itemprop", "author")]))),
            &|| to(self.filter(sel!(None => [Eq("rel", "author", false)]))),
            &|| to(self.filter(sel!(Some("a") => [Contains("class", "author")]))),
            &|| to(self.filter(sel!(None => [Contains("class", "author")], Some("a") => []))),
            &|| to(self.filter(sel!(Some("a") => [Contains("href", "/author/")]))),
            &|| to(self.filter(sel!(Some("a") => [Contains("class", "screenname")]))),
            &|| to(self.filter(sel!(None => [Contains("class", "author")]))),
            &|| {
                to(self.filter_by(byline, |value| {
                    date(&JsValue::String(value.clone()), self.now)
                        .is_none()
                        .then_some(value)
                }))
            },
        ])
    }

    pub fn date(&self) -> Option<String> {
        let to = |value: Option<String>| value.and_then(|v| date(&JsValue::String(v), self.now));
        let to_json = |value: Option<JsValue>| value.and_then(|v| date(&v, self.now));
        let itemprop_date = sel!(None => [Contains("itemprop", "date")]);
        let published = sel!(None => [Eq("itemprop", "datepublished", true)]);
        first(&[
            // dateModified
            &|| to_json(self.jsonld("dateModified")),
            &|| to(self.content(sel!(Some("meta") => [Contains("property", "modified_time")]))),
            &|| to(self.content(sel!(None => [Contains("itemprop", "datemodified")]))),
            // datePublished
            &|| to_json(self.jsonld("datePublished")),
            &|| to_json(self.jsonld("dateCreated")),
            &|| to(self.content(sel!(Some("meta") => [Contains("property", "published_time")]))),
            &|| to(self.content(published)),
            &|| to(self.attr(published, "title")),
            &|| to(self.filter(sel!(None => [Contains("class", "publish")]))),
            // date
            &|| to(self.content(sel!(Some("meta") => [Eq("name", "date", true)]))),
            &|| to(self.content(itemprop_date)),
            &|| to(self.attr(itemprop_date, "title")),
            &|| {
                to(self.attr(
                    sel!(Some("time") => [Contains("itemprop", "date")]),
                    "datetime",
                ))
            },
            &|| to(self.attr(sel!(Some("time") => [Exists("datetime")]), "datetime")),
            &|| to(self.filter(sel!(None => [Contains("class", "byline")]))),
            &|| to(self.filter(sel!(None => [Contains("id", "date")]))),
            &|| to(self.filter(sel!(None => [Contains("class", "date")]))),
            &|| to(self.filter(sel!(None => [Contains("class", "time")]))),
        ])
    }

    pub fn description(&self) -> Option<String> {
        let to = |value: Option<String>| value.map(|v| text::description(&v));
        first(&[
            &|| to(self.content(meta!("property", "og:description"))),
            &|| to(self.content(meta!("name", "twitter:description"))),
            &|| to(self.content(meta!("property", "twitter:description"))),
            &|| to(self.content(meta!("name", "description"))),
            &|| to(self.content(meta!("itemprop", "description"))),
            &|| to(self.jsonld_str("articleBody")),
            &|| to(self.jsonld_str("description")),
        ])
    }

    pub fn image(&self) -> Option<String> {
        let to = |value: Option<String>| value.and_then(|v| image(&v, self.url));
        first(&[
            &|| to(self.content(meta!("property", "og:image:secure_url"))),
            &|| to(self.content(meta!("property", "og:image:url"))),
            &|| to(self.content(meta!("property", "og:image"))),
            &|| to(self.content(meta!("name", "twitter:image:src"))),
            &|| to(self.content(meta!("property", "twitter:image:src"))),
            &|| to(self.content(meta!("name", "twitter:image"))),
            &|| to(self.content(meta!("property", "twitter:image"))),
            &|| to(self.content(meta!("itemprop", "image"))),
            &|| to(self.jsonld_str("image.0.url")),
            &|| to(self.jsonld_str("image.url")),
            &|| to(self.jsonld_str("image")),
            &|| to(self.filter_src(sel!(Some("article") => [], Some("img") => [Exists("src")]))),
            &|| {
                to(self.filter_src(
                    sel!(None => [Eq("id", "content", false)], Some("img") => [Exists("src")]),
                ))
            },
            &|| to(self.attr(sel!(Some("img") => [Contains("alt", "author")]), "src")),
            &|| {
                to(self.attr(
                    sel!(Some("img") => [Exists("src"), NotEq("aria-hidden", "true")]),
                    "src",
                ))
            },
        ])
    }

    pub fn logo(&self) -> Option<String> {
        let to = |value: Option<String>| value.and_then(|v| image(&v, self.url));
        let square = |path: &str| -> Option<String> {
            let logo = self.jsonld(path)?;
            let (width, height) = (get(&logo, "width")?, get(&logo, "height")?);
            if !(width.truthy() && height.truthy() && same_value_zero(width, height)) {
                return None;
            }
            get(&logo, "url")?.as_str().map(str::to_owned)
        };
        first(&[
            &|| to(self.content(meta!("property", "og:logo"))),
            &|| to(self.content(meta!("itemprop", "logo"))),
            &|| to(self.attr(sel!(Some("img") => [Eq("itemprop", "logo", false)]), "src")),
            &|| to(square("brand.logo")),
            &|| to(square("organization.logo")),
            &|| to(square("place.logo")),
            &|| to(square("product.logo")),
            &|| to(square("service.logo")),
            &|| to(square("publisher.logo")),
            &|| to(square("logo.url")),
            &|| to(square("logo")),
        ])
    }

    pub fn publisher(&self) -> Option<String> {
        let to = |value: Option<String>| value.map(|v| text::publisher(&v));
        first(&[
            &|| to(self.jsonld_str("publisher.name")),
            &|| to(self.content(meta!("property", "og:site_name"))),
            &|| to(self.content(sel!(Some("meta") => [Contains("name", "application-name")]))),
            &|| to(self.content(sel!(Some("meta") => [Contains("name", "app-title")]))),
            &|| to(self.content(sel!(Some("meta") => [Contains("property", "app_name")]))),
            &|| to(self.content(sel!(Some("meta") => [Eq("name", "publisher", true)]))),
            &|| to(self.content(meta!("name", "twitter:app:name:iphone"))),
            &|| to(self.content(meta!("property", "twitter:app:name:iphone"))),
            &|| to(self.content(meta!("name", "twitter:app:name:ipad"))),
            &|| to(self.content(meta!("property", "twitter:app:name:ipad"))),
            &|| to(self.content(meta!("name", "twitter:app:name:googleplay"))),
            &|| to(self.content(meta!("property", "twitter:app:name:googleplay"))),
            &|| to(self.filter(sel!(None => [Eq("id", "logo", false)]))),
            &|| to(self.filter(sel!(None => [Class("logo")]))),
            &|| to(self.filter(sel!(Some("a") => [Contains("class", "brand")]))),
            &|| {
                to(self.attr(
                    sel!(None => [Contains("class", "logo")], Some("a") => [], Some("img") => [Exists("alt")]),
                    "alt",
                ))
            },
            &|| {
                to(self.attr(
                    sel!(None => [Contains("class", "logo")], Some("img") => [Exists("alt")]),
                    "alt",
                ))
            },
            &|| to(self.filter_by(sel!(Some("title") => []), |title| from_title(&title))),
        ])
    }

    pub fn title(&self) -> Option<String> {
        let to = |value: Option<String>| value.map(|v| text::title(&v));
        first(&[
            &|| to(self.content(meta!("property", "og:title"))),
            &|| to(self.content(meta!("name", "twitter:title"))),
            &|| to(self.content(meta!("property", "twitter:title"))),
            &|| to(self.filter(sel!(Some("title") => []))),
            &|| to(self.jsonld_str("headline")),
            &|| to(self.filter(sel!(None => [Class("post-title")]))),
            &|| to(self.filter(sel!(None => [Class("entry-title")]))),
            &|| to(self.filter(sel!(Some("h1") => [Contains("class", "title")], Some("a") => []))),
            &|| to(self.filter(sel!(Some("h1") => [Contains("class", "title")]))),
        ])
    }

    pub fn url(&self) -> Option<String> {
        let to = |value: Option<String>| value.and_then(|v| url(&v, self.url));
        let canonical = sel!(Some("link") => [Eq("rel", "canonical", false)]);
        let alternate = sel!(Some("link") => [Eq("rel", "alternate", false), Eq("hreflang", "x-default", false)]);
        first(&[
            &|| to(self.content(meta!("property", "og:url"))),
            &|| to(self.content(meta!("name", "twitter:url"))),
            &|| to(self.content(meta!("property", "twitter:url"))),
            &|| to(self.attr(canonical, "href")),
            &|| to(self.attr(alternate, "href")),
            &|| Some(self.url.to_owned()),
        ])
    }
}

/// lodash `eq`: `SameValueZero`.
fn same_value_zero(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Number(x), JsValue::Number(y)) => x == y,
        (JsValue::String(x), JsValue::String(y)) => x == y,
        (JsValue::Bool(x), JsValue::Bool(y)) => x == y,
        _ => false,
    }
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `getFromTitle(text)` of metascraper-publisher: `/^.*?[-|]\s+(.*)$/` applied until it stops
/// matching, so the text after the last separator. `.` stops at line terminators and `\s+` may
/// cross them. One pass per application, each on a shorter string, so linear overall.
fn from_title(title: &str) -> Option<String> {
    let mut current = title;
    let mut matched = false;
    // After the first application the text holds no line terminator.
    let mut first_terminator = title.find(is_line_terminator).unwrap_or(title.len());
    let mut last_terminator_end = title
        .rfind(is_line_terminator)
        .map(|at| at + title[at..].chars().next().map_or(1, char::len_utf8));
    loop {
        let mut found = None;
        for (i, c) in current[..first_terminator].char_indices() {
            if c != '-' && c != '|' {
                continue;
            }
            let after = &current[i + 1..];
            let ws = after
                .char_indices()
                .find(|(_, c)| !crate::web::extract::utils::js::is_js_whitespace(*c))
                .map_or(after.len(), |(at, _)| at);
            let rest_start = i + 1 + ws;
            if ws > 0 && last_terminator_end.is_none_or(|end| rest_start >= end) {
                found = Some(rest_start);
                break;
            }
        }
        match found {
            Some(start) => {
                matched = true;
                current = &current[start..];
                first_terminator = current.len();
                last_terminator_end = None;
            }
            None => return matched.then(|| current.to_owned()),
        }
    }
}

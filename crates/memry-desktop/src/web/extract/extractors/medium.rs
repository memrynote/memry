//! `dist/extractors/medium.js`: the article stays in the page. `extract` cleans it in place
//! (the live document, as in JS) and hands its selector to Defuddle's pipeline.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, utf16_len};
use crate::web::extract::utils::json::JsValue;

use super::base::{
    Cx, Extracted, Extractor, Variables, description_cut, sel_attr, sel_text, trimmed,
};

pub struct MediumExtractor {
    article: Option<NodeId>,
}

impl MediumExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let article = match cx.qs("article.meteredContent")? {
            Some(a) => Some(a),
            None => cx.qs("article")?,
        };
        Ok(Self { article })
    }
}

const UI_TEXT: [&str; 6] = [
    "Member-only story",
    "Listen",
    "Share",
    "Top highlight",
    "·",
    "Press enter or click to view image in full size",
];

static DATE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[A-Za-z0-9_]{{3}}{WS}+[0-9]{{1,2}},{WS}+[0-9]{{4}}"
    ))
    .expect("static")
});
static AGO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^·{WS}*[0-9]+{WS}*[A-Za-z0-9_]+{WS}*ago$")).expect("static")
});
static MIN_READ: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^·?{WS}*[0-9]+{WS}*min{WS}*read$")).expect("static"));
static NOISE_ONLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^A-Za-z_]+$").expect("static pattern"));

impl MediumExtractor {
    /// `cleanArticle()`: removes Medium's UI from the article before the pipeline runs.
    fn clean_article(&self, cx: &mut Cx) -> Result<(), ExtractError> {
        let Some(article) = self.article else {
            return Ok(());
        };
        for btn in cx
            .doc
            .query_selector_all(article, r#"figure [role="button"]"#)?
        {
            let children = cx.doc.child_nodes(btn);
            cx.doc.replace_with(btn, &children)?;
        }
        for el in cx.doc.query_selector_all(article, r#"[role="tooltip"]"#)? {
            cx.doc.remove_attribute(el, "role");
        }
        for link in cx
            .doc
            .query_selector_all(article, r#"a[href*="medium.com/plans"]"#)?
        {
            match cx.doc.closest(link, "div")? {
                Some(wrapper) if wrapper != article => cx.doc.remove(wrapper),
                _ => cx.doc.remove(link),
            }
        }
        for selector in [
            r#"[data-testid="post-preview"]"#,
            r#"[data-testid*="Clap"], [data-testid*="Bookmark"], [data-testid*="Share"], [data-testid*="Response"]"#,
            r#"[data-testid="authorPhoto"], [data-testid="authorName"], [data-testid="storyReadTime"]"#,
        ] {
            for el in cx.doc.query_selector_all(article, selector)? {
                cx.doc.remove(el);
            }
        }
        for el in cx.doc.query_selector_all(article, "p, span, div")? {
            let text = trimmed(cx.doc, el);
            if text.is_empty() {
                continue;
            }
            if UI_TEXT.contains(&text.as_str())
                || (DATE_LINE.is_match(&text) && utf16_len(&text) < 30)
                || AGO.is_match(&text)
                || MIN_READ.is_match(&text)
            {
                cx.doc.remove(el);
            }
        }
        Ok(())
    }

    fn publication(cx: &Cx) -> Result<String, ExtractError> {
        let site = sel_attr(
            cx.doc,
            cx.root,
            r#"meta[property="og:site_name"]"#,
            "content",
        )?;
        if !site.is_empty() && site != "Medium" {
            return Ok(site);
        }
        let schemas: Vec<&JsValue> = match cx.schema {
            JsValue::Array(items) => items.iter().collect(),
            other => vec![other],
        };
        for schema in schemas {
            if let Some(name) = schema.get("publisher").and_then(|p| p.get("name"))
                && name.truthy()
            {
                return Ok(name.to_js_string());
            }
        }
        Ok(String::new())
    }

    fn description(&self, cx: &Cx) -> Result<String, ExtractError> {
        let Some(article) = self.article else {
            return Ok(String::new());
        };
        for p in cx.doc.query_selector_all(article, "p")? {
            let text = trimmed(cx.doc, p);
            if utf16_len(&text) < 3 || NOISE_ONLY.is_match(&text) {
                continue;
            }
            return Ok(description_cut(&text));
        }
        Ok(String::new())
    }
}

impl Extractor for MediumExtractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        let Some(article) = self.article else {
            return Ok(false);
        };
        if cx.doc.class_list_contains(article, "meteredContent") {
            return Ok(true);
        }
        let site = sel_attr(
            cx.doc,
            cx.root,
            r#"meta[property="og:site_name"]"#,
            "content",
        )?;
        let app = sel_attr(
            cx.doc,
            cx.root,
            r#"meta[property="al:android:app_name"]"#,
            "content",
        )?;
        Ok(site == "Medium" || app == "Medium")
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let title = match cx.qs(r#"[data-testid="storyTitle"]"#)? {
            Some(story) => trimmed(cx.doc, story),
            None => match self.article {
                Some(a) => sel_text(cx.doc, a, "h1")?,
                None => String::new(),
            },
        };
        let subtitle = sel_text(cx.doc, cx.root, ".pw-subtitle-paragraph")?;
        let author = sel_text(cx.doc, cx.root, r#"[data-testid="authorName"]"#)?;
        let publication = Self::publication(cx)?;
        self.clean_article(cx)?;
        let description = if subtitle.is_empty() {
            self.description(cx)?
        } else {
            subtitle
        };
        Ok(Extracted {
            content_html: String::new(),
            content_selector: Some("article".to_string()),
            variables: Variables {
                title,
                author,
                site: if publication.is_empty() {
                    "Medium".into()
                } else {
                    publication
                },
                description,
                ..Variables::default()
            },
        })
    }
}

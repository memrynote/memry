//! `dist/extractors/github.js`: issues and pull requests.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{Comment, build_comment_tree, build_content_html};
use crate::web::extract::utils::date::iso_date_from_text;
use crate::web::extract::utils::dom::document_title;
use crate::web::extract::utils::js::trim;

use super::base::{
    Cx, Extracted, Extractor, Variables, attr_of, description_cut, sel_attr, text_of, trimmed,
};

pub struct GitHubExtractor {
    is_issue: bool,
    is_pr: bool,
}

static ISSUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/issues/[0-9]+").expect("static"));
static PULL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/pull/[0-9]+").expect("static"));
static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/(issues|pull)/([0-9]+)").expect("static"));
static REPO_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"github\.com/([^/]+)/([^/]+)").expect("static"));
static REPO_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "([^/{ws}]+)/([^/{ws}]+)",
        ws = crate::web::extract::utils::js::WS_BODY
    ))
    .expect("static")
});
static HASH_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#([0-9]+)").expect("static"));
static HOST_USER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"github\.com/([^/?#]+)").expect("static"));
static HIGHLIGHT_LANG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"highlight-source-([A-Za-z0-9_]+)").expect("static"));

impl GitHubExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            is_issue: ISSUE.is_match(cx.url),
            is_pr: PULL.is_match(cx.url),
        })
    }

    fn any(cx: &Cx, selectors: &[&str]) -> Result<bool, ExtractError> {
        for selector in selectors {
            if cx.qs(selector)?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn author_from(cx: &Cx, container: NodeId, selectors: &[&str]) -> Result<String, ExtractError> {
        for selector in selectors {
            let Some(link) = cx.doc.query_selector(container, selector)? else {
                continue;
            };
            let href = attr_of(cx.doc, link, "href");
            if href.is_empty() {
                continue;
            }
            if let Some(rest) = href.strip_prefix('/') {
                return Ok(rest.to_string());
            }
            if href.contains("github.com/")
                && let Some(m) = HOST_USER.captures(&href)
            {
                return Ok(m[1].to_string());
            }
        }
        Ok("Unknown".to_string())
    }

    /// `cleanBodyContent`: UI controls go, and GitHub's highlighted code becomes `<pre><code>`.
    fn clean_body(cx: &mut Cx, body: NodeId) -> Result<String, ExtractError> {
        let clean = cx.doc.clone_node(body, true);
        for selector in [
            r#"button, [data-testid*="button"], [data-testid*="menu"]"#,
            ".js-clipboard-copy, .zeroclipboard-container",
        ] {
            for el in cx.doc.query_selector_all(clean, selector)? {
                cx.doc.remove(el);
            }
        }
        for pre in cx.doc.query_selector_all(
            clean,
            r#"div.highlight[class*="highlight-source-"] pre, div.highlight pre"#,
        )? {
            let Some(wrapper) = cx.doc.parent_element(pre) else {
                continue;
            };
            let class = cx.doc.class_name(wrapper);
            let lang = HIGHLIGHT_LANG
                .captures(&class)
                .map(|m| m[1].to_string())
                .unwrap_or_default();
            let snippet = attr_of(cx.doc, wrapper, "data-snippet-clipboard-copy-content");
            let content = if snippet.is_empty() {
                text_of(cx.doc, pre)
            } else {
                snippet
            };
            let code = cx.doc.create_element("code");
            if !lang.is_empty() {
                cx.doc
                    .set_attribute(code, "class", &format!("language-{lang}"));
                cx.doc.set_attribute(code, "data-lang", &lang);
            }
            cx.doc.set_text_content(code, &content)?;
            let new_pre = cx.doc.create_element("pre");
            cx.doc.append_child(new_pre, code)?;
            cx.doc.replace_with(wrapper, &[new_pre])?;
        }
        Ok(trim(&cx.doc.inner_html(clean)).to_string())
    }

    fn date_of(cx: &Cx, scope: NodeId) -> Result<String, ExtractError> {
        let timestamp = sel_attr(cx.doc, scope, "relative-time", "datetime")?;
        if timestamp.is_empty() {
            Ok(String::new())
        } else {
            iso_date_from_text(&timestamp)
        }
    }

    fn issue_content(cx: &mut Cx) -> Result<(String, String, String), ExtractError> {
        let Some(container) = cx.qs(r#"[data-testid="issue-viewer-issue-container"]"#)? else {
            return Ok((String::new(), String::new(), String::new()));
        };
        let author = Self::author_from(
            cx,
            container,
            &[
                r#"a[data-testid="issue-body-header-author"]"#,
                ".IssueBodyHeaderAuthor-module__authorLoginLink--_S7aT",
                ".ActivityHeader-module__AuthorLink--iofTU",
                r#"a[href*="/users/"][data-hovercard-url*="/users/"]"#,
                r#"a[aria-label*="profile"]"#,
            ],
        )?;
        let published = sel_attr(cx.doc, container, "relative-time", "datetime")?;
        let Some(body) = cx.doc.query_selector(
            container,
            r#"[data-testid="issue-body-viewer"] .markdown-body"#,
        )?
        else {
            return Ok((String::new(), author, published));
        };
        Ok((Self::clean_body(cx, body)?, author, published))
    }

    fn issue_comments(cx: &mut Cx) -> Result<String, ExtractError> {
        let mut seen = HashSet::new();
        let mut data = Vec::new();
        for element in cx.qsa("[data-wrapper-timeline-id]")? {
            let Some(container) = cx.doc.query_selector(element, ".react-issue-comment")? else {
                continue;
            };
            let id = attr_of(cx.doc, element, "data-wrapper-timeline-id");
            if id.is_empty() || !seen.insert(id) {
                continue;
            }
            let author = Self::author_from(
                cx,
                container,
                &[
                    ".ActivityHeader-module__AuthorLink--iofTU",
                    r#"a[data-testid="avatar-link"]"#,
                    r#"a[href^="/"][data-hovercard-url*="/users/"]"#,
                ],
            )?;
            let date = Self::date_of(cx, container)?;
            let Some(body) = cx.doc.query_selector(container, ".markdown-body")? else {
                continue;
            };
            let content = Self::clean_body(cx, body)?;
            if content.is_empty() {
                continue;
            }
            data.push(Comment {
                author,
                date,
                content,
                ..Comment::default()
            });
        }
        Ok(build_comment_tree(&data))
    }

    fn pr_body(cx: &Cx) -> Result<Option<NodeId>, ExtractError> {
        Ok(match cx.qs(r#"[id^="pullrequest-"]"#)? {
            Some(el) => Some(el),
            None => cx.qs(".timeline-comment")?,
        })
    }

    fn pr_content(
        cx: &mut Cx,
        pr: Option<NodeId>,
    ) -> Result<(String, String, String), ExtractError> {
        let mut body = match pr {
            Some(p) => cx.doc.query_selector(p, ".comment-body.markdown-body")?,
            None => None,
        };
        if body.is_none() {
            body = cx.qs(".comment-body.markdown-body")?;
        }
        let content = match body {
            Some(b) => Self::clean_body(cx, b)?,
            None => String::new(),
        };
        let mut author_el = match pr {
            Some(p) => cx.doc.query_selector(p, ".author")?,
            None => None,
        };
        if author_el.is_none() {
            author_el = cx.qs(".gh-header-meta .author")?;
        }
        let author = author_el.map(|a| trimmed(cx.doc, a)).unwrap_or_default();
        let published = match pr {
            Some(p) => sel_attr(cx.doc, p, "relative-time", "datetime")?,
            None => String::new(),
        };
        Ok((content, author, published))
    }

    fn pr_comments(cx: &mut Cx, pr: Option<NodeId>) -> Result<String, ExtractError> {
        let mut data = Vec::new();
        for comment in cx.qsa(".timeline-comment, .review-comment")? {
            if let Some(p) = pr
                && cx.doc.contains(p, comment)
            {
                continue;
            }
            let author = match cx.doc.query_selector(comment, ".author")? {
                Some(a) => trimmed(cx.doc, a),
                None => String::new(),
            };
            let date = Self::date_of(cx, comment)?;
            let Some(body) = cx
                .doc
                .query_selector(comment, ".comment-body.markdown-body")?
            else {
                continue;
            };
            let content = Self::clean_body(cx, body)?;
            if content.is_empty() {
                continue;
            }
            data.push(Comment {
                author,
                date,
                content,
                ..Comment::default()
            });
        }
        Ok(build_comment_tree(&data))
    }

    fn number(&self, cx: &Cx) -> Result<String, ExtractError> {
        if let Some(m) = NUMBER.captures(cx.url) {
            return Ok(m[2].to_string());
        }
        Ok(match cx.qs("h1")? {
            Some(h1) => HASH_NUMBER
                .captures(&text_of(cx.doc, h1))
                .map(|m| m[1].to_string())
                .unwrap_or_default(),
            None => String::new(),
        })
    }

    fn repo_info(cx: &mut Cx) -> (String, String) {
        if let Some(m) = REPO_URL.captures(cx.url) {
            return (m[1].to_string(), m[2].to_string());
        }
        let title = document_title(cx.doc, cx.root);
        match REPO_TITLE.captures(&title) {
            Some(m) => (m[1].to_string(), m[2].to_string()),
            None => (String::new(), String::new()),
        }
    }
}

impl Extractor for GitHubExtractor {
    fn can_extract(&mut self, cx: &mut Cx) -> Result<bool, ExtractError> {
        if !Self::any(
            cx,
            &[
                r#"meta[name="expected-hostname"][content="github.com"]"#,
                r#"meta[name="octolytics-url"]"#,
                r#"meta[name="github-keyboard-shortcuts"]"#,
                ".js-header-wrapper",
                "#js-repo-pjax-container",
            ],
        )? {
            return Ok(false);
        }
        if self.is_issue {
            return Self::any(
                cx,
                &[
                    r#"[data-testid="issue-metadata-sticky"]"#,
                    r#"[data-testid="issue-title"]"#,
                ],
            );
        }
        if self.is_pr {
            return Self::any(
                cx,
                &[
                    ".pull-discussion-timeline",
                    ".discussion-timeline",
                    ".gh-header-title",
                    ".js-issue-title",
                ],
            );
        }
        Ok(false)
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let (owner, repo) = Self::repo_info(cx);
        let _number = self.number(cx)?;
        let pr = if self.is_pr { Self::pr_body(cx)? } else { None };
        let (post, author, published) = if self.is_pr {
            Self::pr_content(cx, pr)?
        } else {
            Self::issue_content(cx)?
        };
        let comments = if self.is_pr {
            Self::pr_comments(cx, pr)?
        } else {
            Self::issue_comments(cx)?
        };
        let content_html = build_content_html("github", &post, &comments);
        let title = document_title(cx.doc, cx.root);
        let description = if content_html.is_empty() {
            String::new()
        } else {
            let temp = cx.doc.create_element("div");
            let fragment = cx.doc.parse_fragment(&content_html);
            cx.doc.append_child(temp, fragment)?;
            description_cut(trim(&text_of(cx.doc, temp)))
        };
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title,
                author,
                published,
                site: format!("GitHub - {owner}/{repo}"),
                description,
                ..Variables::default()
            },
        })
    }
}

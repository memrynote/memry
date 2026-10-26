//! `dist/extractors/twitter.js`: a tweet page or timeline, with its thread and replies.
//!
//! The constructor stops a timeline that has a `section` or `h2` with a `ReferenceError`
//! (`Node.DOCUMENT_POSITION_FOLLOWING` is not defined in Node), which ends the registry search
//! with no extractor, so such a page falls to the generic pipeline.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{
    Comment, QuotedPost, build_comment_tree, build_content_html, build_quoted_post,
};
use crate::web::extract::utils::date::iso_date_from_text;
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::{WS, trim};

use super::base::{
    Cx, Extracted, Extractor, Variables, anchor_href, attr_of, description_cut, post_title,
    text_of, trimmed,
};

pub struct TwitterExtractor {
    main_tweet: Option<NodeId>,
    thread: Vec<NodeId>,
    replies: Vec<NodeId>,
    depths: Vec<f64>,
}

static HANDLE_IN_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(@[A-Za-z0-9_]+)").expect("static pattern"));
static NAME_PARAM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&name=[A-Za-z0-9_]+$").expect("static pattern"));
static RUNS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{WS}+")).expect("static pattern"));

fn handle_of(cx: &Cx, tweet: NodeId) -> Result<String, ExtractError> {
    let Some(name) = cx
        .doc
        .query_selector(tweet, r#"[data-testid="User-Name"]"#)?
    else {
        return Ok(String::new());
    };
    let links = cx.doc.query_selector_all(name, "a")?;
    Ok(links
        .get(1)
        .map(|&l| trimmed(cx.doc, l))
        .unwrap_or_default())
}

impl TwitterExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        let mut this = Self {
            main_tweet: None,
            thread: Vec::new(),
            replies: Vec::new(),
            depths: Vec::new(),
        };
        let mut timeline = None;
        for el in cx.qsa("[aria-label]")? {
            if cx
                .doc
                .query_selector(el, r#"[data-testid="cellInnerDiv"]"#)?
                .is_some()
            {
                timeline = Some(el);
                break;
            }
        }
        let Some(timeline) = timeline else {
            this.main_tweet = cx.qs(r#"article[data-testid="tweet"]"#)?;
            return Ok(this);
        };
        let cells = cx
            .doc
            .query_selector_all(timeline, r#"[data-testid="cellInnerDiv"]"#)?;
        let first_section = match cx.doc.query_selector(timeline, "section, h2")? {
            Some(el) => cx.doc.parent_element(el),
            None => None,
        };
        if first_section.is_some() && !cells.is_empty() {
            return Err(ExtractError::Js(
                "ReferenceError: Node is not defined".into(),
            ));
        }
        let (mut main_handle, mut first, mut ended, mut last_was_tweet, mut depth) =
            (String::new(), true, false, false, 0.0);
        for cell in cells {
            let Some(article) = cx
                .doc
                .query_selector(cell, r#"article[data-testid="tweet"]"#)?
            else {
                last_was_tweet = false;
                continue;
            };
            if first {
                this.main_tweet = Some(article);
                main_handle = handle_of(cx, article)?;
                first = false;
                last_was_tweet = true;
                continue;
            }
            let handle = handle_of(cx, article)?;
            if !ended && handle == main_handle {
                this.thread.push(article);
                last_was_tweet = true;
                continue;
            }
            ended = true;
            if last_was_tweet {
                depth += 1.0
            } else {
                depth = 0.0
            }
            this.replies.push(article);
            this.depths.push(depth);
            last_was_tweet = true;
        }
        Ok(this)
    }
}

/// `formatTweetText(text)`: links become their text, wrappers unwrap, lines become paragraphs.
fn format_tweet_text(cx: &mut Cx, text: &str) -> Result<String, ExtractError> {
    if text.is_empty() {
        return Ok(String::new());
    }
    let temp = cx.doc.create_element("div");
    let fragment = cx.doc.parse_fragment(text);
    cx.doc.append_child(temp, fragment)?;
    for link in cx.doc.query_selector_all(temp, "a")? {
        let handle = trimmed(cx.doc, link);
        let node = cx.doc.create_text_node(&handle);
        cx.doc.replace_with(link, &[node])?;
    }
    for el in cx.doc.query_selector_all(temp, "span, div")? {
        let children = cx.doc.child_nodes(el);
        cx.doc.replace_with(el, &children)?;
    }
    let clean = cx.doc.inner_html(temp);
    let paragraphs: Vec<String> = clean
        .split('\n')
        .map(|line| trim(line).to_string())
        .filter(|line| !line.is_empty())
        .map(|p| format!("<p>{p}</p>"))
        .collect();
    Ok(paragraphs.join("\n"))
}

fn replace_emoji_images(cx: &mut Cx, container: NodeId) -> Result<(), ExtractError> {
    for img in cx
        .doc
        .query_selector_all(container, r#"img[src*="/emoji/"]"#)?
    {
        let alt = attr_of(cx.doc, img, "alt");
        if !alt.is_empty() {
            let node = cx.doc.create_text_node(&alt);
            cx.doc.replace_with(img, &[node])?;
        }
    }
    Ok(())
}

fn find_quoted_tweet(cx: &Cx, tweet: NodeId) -> Result<Option<NodeId>, ExtractError> {
    let Some(labelled) = cx
        .doc
        .query_selector(tweet, r#"[aria-labelledby*="id__"]"#)?
    else {
        return Ok(None);
    };
    let Some(name) = cx
        .doc
        .query_selector(labelled, r#"[data-testid="User-Name"]"#)?
    else {
        return Ok(None);
    };
    cx.doc.closest(name, r#"[aria-labelledby*="id__"]"#)
}

struct UserInfo {
    full_name: String,
    handle: String,
    date: String,
    permalink: String,
}

fn user_info(cx: &Cx, tweet: NodeId) -> Result<UserInfo, ExtractError> {
    let Some(name) = cx
        .doc
        .query_selector(tweet, r#"[data-testid="User-Name"]"#)?
    else {
        return Ok(UserInfo {
            full_name: String::new(),
            handle: String::new(),
            date: String::new(),
            permalink: String::new(),
        });
    };
    let links = cx.doc.query_selector_all(name, "a")?;
    let mut full_name = links
        .first()
        .map(|&l| trimmed(cx.doc, l))
        .unwrap_or_default();
    let mut handle = links
        .get(1)
        .map(|&l| trimmed(cx.doc, l))
        .unwrap_or_default();
    if full_name.is_empty() || handle.is_empty() {
        let children = cx.doc.children(name);
        if children.len() >= 2 {
            full_name = trimmed(cx.doc, children[0]);
            let second = trimmed(cx.doc, children[1]);
            handle = HANDLE_IN_TEXT
                .find(&second)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
        }
    }
    let time = cx.doc.query_selector(tweet, "time")?;
    let datetime = time
        .map(|t| attr_of(cx.doc, t, "datetime"))
        .unwrap_or_default();
    let date = if datetime.is_empty() {
        String::new()
    } else {
        iso_date_from_text(&datetime)?
    };
    let permalink = match time {
        Some(t) => match cx.doc.closest(t, "a")? {
            Some(a) => anchor_href(cx.doc, a)?,
            None => String::new(),
        },
        None => String::new(),
    };
    Ok(UserInfo {
        full_name,
        handle,
        date,
        permalink,
    })
}

fn extract_images(
    cx: &Cx,
    tweet: NodeId,
    quoted: Option<NodeId>,
) -> Result<Vec<String>, ExtractError> {
    let mut images = Vec::new();
    for selector in [
        r#"[data-testid="tweetPhoto"]"#,
        r#"[data-testid="tweet-image"]"#,
        r#"img[src*="media"]"#,
    ] {
        for img in cx.doc.query_selector_all(tweet, selector)? {
            if quoted.is_some_and(|q| cx.doc.contains(q, img)) {
                continue;
            }
            let alt = attr_of(cx.doc, img, "alt");
            if cx.doc.local_name(img).map(str::to_lowercase).as_deref() == Some("img")
                && !alt.is_empty()
            {
                let src = attr_of(cx.doc, img, "src");
                let high = NAME_PARAM.replace(&src, "&name=large");
                let clean_alt = trim(&RUNS.replace_all(&alt, " ")).to_string();
                images.push(format!(
                    "<img src=\"{}\" alt=\"{}\" />",
                    escape_html(&high),
                    escape_html(&clean_alt)
                ));
            }
        }
    }
    Ok(images)
}

fn extract_card(cx: &Cx, tweet: NodeId) -> Result<String, ExtractError> {
    let Some(card) = cx
        .doc
        .query_selector(tweet, r#"[data-testid="card.wrapper"]"#)?
    else {
        return Ok(String::new());
    };
    let Some(link) = cx.doc.query_selector(card, "a[href]")? else {
        return Ok(String::new());
    };
    let href = attr_of(cx.doc, link, "href");
    let label = attr_of(cx.doc, link, "aria-label");
    let first_line = trim(label.split('\n').next().unwrap_or_default()).to_string();
    let title = if first_line.is_empty() {
        href.clone()
    } else {
        first_line
    };
    Ok(format!(
        "<p><a href=\"{}\">{}</a></p>",
        escape_html(&href),
        escape_html(&title)
    ))
}

/// The `tweetText` of a clone, formatted.
fn formatted_text(cx: &mut Cx, tweet: NodeId) -> Result<String, ExtractError> {
    let clone = cx.doc.clone_node(tweet, true);
    replace_emoji_images(cx, clone)?;
    let text = match cx
        .doc
        .query_selector(clone, r#"[data-testid="tweetText"]"#)?
    {
        Some(el) => cx.doc.inner_html(el),
        None => String::new(),
    };
    format_tweet_text(cx, &text)
}

fn extract_quoted_tweet(cx: &mut Cx, quoted: NodeId) -> Result<String, ExtractError> {
    let text = formatted_text(cx, quoted)?;
    let info = user_info(cx, quoted)?;
    let images = extract_images(cx, quoted, None)?;
    let mut content = text;
    if !images.is_empty() {
        content.push_str(&format!("\n{}", images.join("\n")));
    }
    let author = if info.full_name.is_empty() {
        info.handle.clone()
    } else {
        format!("{} {}", info.full_name, info.handle)
    };
    Ok(build_quoted_post(&QuotedPost {
        author,
        date: info.date,
        content,
        url: String::new(),
    }))
}

fn extract_tweet_content(cx: &mut Cx, tweet: NodeId) -> Result<String, ExtractError> {
    let text = formatted_text(cx, tweet)?;
    let quoted = find_quoted_tweet(cx, tweet)?;
    let images = extract_images(cx, tweet, quoted)?;
    let quoted_html = match quoted {
        Some(q) => extract_quoted_tweet(cx, q)?,
        None => String::new(),
    };
    let card = extract_card(cx, tweet)?;
    let mut html = text;
    if !images.is_empty() {
        html.push_str(&format!("\n{}", images.join("\n")));
    }
    if !card.is_empty() {
        html.push_str(&format!("\n{card}"));
    }
    if !quoted_html.is_empty() {
        html.push_str(&format!("\n{quoted_html}"));
    }
    Ok(html)
}

impl Extractor for TwitterExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(self.main_tweet.is_some())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        let main = self
            .main_tweet
            .ok_or_else(|| ExtractError::Js("TypeError: mainTweet is null".into()))?;
        let mut parts = vec![extract_tweet_content(cx, main)?];
        for &tweet in &self.thread {
            parts.push(extract_tweet_content(cx, tweet)?);
        }
        let post_content = parts.join("\n<hr>\n");
        let mut data = Vec::new();
        for (i, &tweet) in self.replies.iter().enumerate() {
            let info = user_info(cx, tweet)?;
            let content = extract_tweet_content(cx, tweet)?;
            data.push(Comment {
                author: if info.full_name.is_empty() {
                    info.handle.clone()
                } else {
                    format!("{} {}", info.full_name, info.handle)
                },
                date: info.date,
                content,
                depth: Some(self.depths[i]),
                url: Some(info.permalink).filter(|u| !u.is_empty()),
                score: None,
            });
        }
        let comments = if data.is_empty() {
            String::new()
        } else {
            build_comment_tree(&data)
        };
        let content_html = build_content_html("twitter", &post_content, &comments);
        let handle = handle_of(cx, main)?;
        let author = if handle.starts_with('@') {
            handle
        } else {
            format!("@{handle}")
        };
        let description = match cx
            .doc
            .query_selector(main, r#"[data-testid="tweetText"]"#)?
        {
            Some(el) => description_cut(trim(&text_of(cx.doc, el))),
            None => String::new(),
        };
        Ok(Extracted {
            content_html,
            content_selector: None,
            variables: Variables {
                title: post_title(&author, "X"),
                author,
                site: "X (Twitter)".into(),
                description,
                ..Variables::default()
            },
        })
    }
}

//! Standardized comment HTML (`dist/utils/comments.js`), used by the extractors that carry a
//! comment thread. The strings keep the tabs and newlines of the JS template literals: they are
//! parsed as HTML text and reach the markdown.

use super::dom::{escape_html, is_dangerous_url};

/// One comment of a flat list. `depth` and `score` may be absent, as in JS.
#[derive(Debug, Clone, Default)]
pub struct Comment {
    pub author: String,
    pub date: String,
    pub content: String,
    /// A JS number: `NaN` and fractions occur when the depth comes from a parsed width.
    pub depth: Option<f64>,
    pub url: Option<String>,
    pub score: Option<String>,
}

/// `buildContentHtml(site, postContent, comments)`.
pub fn build_content_html(site: &str, post_content: &str, comments: &str) -> String {
    let comments_html = if comments.is_empty() {
        String::new()
    } else {
        format!(
            "\n\t\t\t\t<hr>\n\t\t\t\t<div class=\"{site} comments\">\n\t\t\t\t\t<h2>Comments</h2>\n\t\t\t\t\t{comments}\n\t\t\t\t</div>\n\t\t\t"
        )
    };
    let html = format!(
        "\n\t\t<article data-defuddle>\n\t\t\t<div class=\"{site} post\">\n\t\t\t\t<div class=\"post-content\">\n\t\t\t\t\t{post_content}\n\t\t\t\t</div>\n\t\t\t</div>\n\t\t\t{comments_html}\n\t\t</article>\n\t"
    );
    super::js::trim(&html).to_string()
}

/// `buildCommentTree(comments)`: `<blockquote>` nesting that follows the depth of each comment.
pub fn build_comment_tree(comments: &[Comment]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut stack: Vec<f64> = Vec::new();
    for comment in comments {
        let depth = comment.depth.unwrap_or(0.0);
        if depth == 0.0 {
            while stack.pop().is_some() {
                parts.push("</blockquote>".into());
            }
            parts.push("<blockquote>".into());
            stack.push(0.0);
        } else {
            let current = stack.last().copied().unwrap_or(-1.0);
            if depth < current {
                while stack.last().is_some_and(|&top| top >= depth) {
                    parts.push("</blockquote>".into());
                    stack.pop();
                }
            }
            let now = stack.last().copied().unwrap_or(-1.0);
            if depth > now {
                parts.push("<blockquote>".into());
                stack.push(depth);
            }
        }
        parts.push(build_comment(comment));
    }
    while stack.pop().is_some() {
        parts.push("</blockquote>".into());
    }
    parts.concat()
}

/// `buildComment(comment)`: author, date (a link when the URL is safe) and optional score.
pub fn build_comment(comment: &Comment) -> String {
    let author = format!(
        "<span class=\"comment-author\"><strong>{}</strong></span>",
        escape_html(&comment.author)
    );
    let safe_url = comment
        .url
        .as_deref()
        .filter(|u| !u.is_empty() && !is_dangerous_url(u))
        .unwrap_or("");
    let date = escape_html(&comment.date);
    let date_html = if safe_url.is_empty() {
        format!("<span class=\"comment-date\">{date}</span>")
    } else {
        format!(
            "<a href=\"{}\" class=\"comment-link\">{date}</a>",
            escape_html(safe_url)
        )
    };
    let score_html = match comment.score.as_deref() {
        Some(score) if !score.is_empty() => {
            format!(
                " · <span class=\"comment-points\">{}</span>",
                escape_html(score)
            )
        }
        _ => String::new(),
    };
    format!(
        "<div class=\"comment\">\n\t<div class=\"comment-metadata\">\n\t\t{author} · {date_html}{score_html}\n\t</div>\n\t<div class=\"comment-content\">{}</div>\n</div>",
        comment.content
    )
}

/// A quoted or reposted post for `build_quoted_post`.
#[derive(Debug, Clone, Default)]
pub struct QuotedPost {
    pub author: String,
    pub date: String,
    pub content: String,
    pub url: String,
}

/// `buildQuotedPost(post)`.
pub fn build_quoted_post(post: &QuotedPost) -> String {
    let mut header = String::new();
    if !post.author.is_empty() {
        header.push_str(&format!(
            "<p><strong>{}</strong>",
            escape_html(&post.author)
        ));
        if !post.date.is_empty() {
            header.push_str(&format!(" · {}", escape_html(&post.date)));
        }
        header.push_str("</p>");
    }
    let mut footer = String::new();
    if !post.url.is_empty() && !is_dangerous_url(&post.url) {
        let url = escape_html(&post.url);
        footer = format!("\n<p><a href=\"{url}\">{url}</a></p>");
    }
    format!(
        "<blockquote class=\"quoted-post\">{header}{}{footer}</blockquote>",
        post.content
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_reopens_after_closing_levels() {
        let c = |depth: f64| Comment {
            author: "a".into(),
            date: "d".into(),
            content: "c".into(),
            depth: Some(depth),
            ..Comment::default()
        };
        let html = build_comment_tree(&[c(0.0), c(2.0), c(1.0), c(1.0)]);
        // Node 24 gives 3 and 3 for this input.
        assert_eq!(html.matches("<blockquote>").count(), 3);
        assert_eq!(html.matches("</blockquote>").count(), 3);
    }
}

//! The block serializers of `htmlToMarkdown.ts` (paragraph to details).

use super::inline::{escape_html_attr, escape_html_text, format_link, serialize_inline_content};
use super::{Ctx, element_children, query_tag, serialize_children, serialize_node, tag};
use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::frontmatter::js::js_trim;

/// `trimHardBreaks`: leading and trailing `\` + newline pairs.
fn trim_hard_breaks(content: &str) -> &str {
    let mut s = content;
    while let Some(rest) = s.strip_prefix("\\\n") {
        s = rest;
    }
    while let Some(rest) = s.strip_suffix("\\\n") {
        s = rest;
    }
    s
}

pub(super) fn paragraph(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let content = serialize_inline_content(dom, el);
    let trimmed = trim_hard_breaks(&content);
    if ctx.in_list_item {
        return trimmed.to_owned();
    }
    format!("{}{}\n\n", ctx.indent, trimmed)
}

pub(super) fn heading(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let level = tag(dom, el)[1..].parse::<usize>().unwrap_or(1);
    format!(
        "{}{} {}\n\n",
        ctx.indent,
        "#".repeat(level),
        serialize_inline_content(dom, el)
    )
}

pub(super) fn blockquote(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let blocks: Vec<NodeId> = element_children(dom, el)
        .into_iter()
        .filter(|c| {
            matches!(
                tag(dom, *c).as_str(),
                "p" | "ul" | "ol" | "pre" | "blockquote" | "table" | "hr"
            )
        })
        .collect();
    let content = if blocks.is_empty() {
        serialize_inline_content(dom, el)
    } else {
        let inner = Ctx {
            indent: String::new(),
            in_list_item: false,
        };
        blocks
            .iter()
            .map(|child| {
                if tag(dom, *child) == "p" {
                    serialize_inline_content(dom, *child)
                } else {
                    js_trim(&serialize_node(dom, *child, &inner)).to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let lines: Vec<String> = content
        .split('\n')
        .map(|line| format!("{}> {}", ctx.indent, line))
        .collect();
    format!("{}\n\n", lines.join("\n"))
}

fn code_content(dom: &Dom, el: NodeId) -> String {
    let mut result = String::new();
    for child in dom.children(el).to_vec() {
        if let Some(text) = dom.text_value(child) {
            result.push_str(text);
        } else if dom.is_element(child) {
            if tag(dom, child) == "br" {
                result.push('\n');
            } else {
                result.push_str(&code_content(dom, child));
            }
        }
    }
    result
}

/// The longest run of backticks in `text`.
pub(super) fn longest_backtick_run(text: &str) -> usize {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    longest
}

/// `extractLanguageFromClass`: `language-(\S+)`.
fn language_from_class(class: &str) -> String {
    let Some(at) = class.find("language-") else {
        return String::new();
    };
    class[at + "language-".len()..]
        .chars()
        .take_while(|c| !crate::markdown::frontmatter::js::is_js_whitespace(*c))
        .collect()
}

pub(super) fn code_block(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let Some(code_el) = query_tag(dom, el, "code") else {
        return String::new();
    };
    let data_language = dom.attr(code_el, "data-language").unwrap_or("");
    let language = if data_language.is_empty() {
        language_from_class(dom.attr(code_el, "class").unwrap_or(""))
    } else {
        data_language.to_owned()
    };
    let code = code_content(dom, code_el);
    let fence = "`".repeat(3.max(longest_backtick_run(&code) + 1));
    if code.is_empty() {
        return format!("{0}{fence}{language}\n{0}{fence}\n\n", ctx.indent);
    }
    let body = code.strip_suffix('\n').unwrap_or(&code);
    let mut lines = vec![format!("{fence}{language}")];
    lines.extend(body.split('\n').map(str::to_owned));
    lines.push(fence);
    let lines: Vec<String> = lines
        .into_iter()
        .map(|line| {
            if line.is_empty() {
                line
            } else {
                format!("{}{}", ctx.indent, line)
            }
        })
        .collect();
    format!("{}\n\n", lines.join("\n"))
}

pub(super) fn image(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let src = dom.attr(el, "src").unwrap_or("");
    let alt = dom.attr(el, "alt").unwrap_or("");
    if src.is_empty() {
        return "\n\n".into();
    }
    format!("{}![{alt}]({src})\n\n", ctx.indent)
}

fn video_source<'a>(dom: &'a Dom, el: NodeId) -> (&'a str, &'a str) {
    let pick = |a: &'static str, b: &'static str| -> &'a str {
        match dom.attr(el, a) {
            Some(v) if !v.is_empty() => v,
            _ => dom.attr(el, b).unwrap_or(""),
        }
    };
    (pick("src", "data-url"), pick("data-name", "title"))
}

pub(super) fn video(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let (src, name) = video_source(dom, el);
    if src.is_empty() {
        return "\n\n".into();
    }
    format!("{}![{name}]({src})\n\n", ctx.indent)
}

pub(super) fn audio(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let src = dom.attr(el, "src").unwrap_or("");
    if src.is_empty() {
        return "\n\n".into();
    }
    format!(
        "{}<audio src=\"{}\" controls></audio>\n\n",
        ctx.indent,
        escape_html_attr(src)
    )
}

pub(super) fn embed(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let src = dom.attr(el, "src").unwrap_or("");
    if src.is_empty() {
        return "\n\n".into();
    }
    format!("{}[]({src})\n\n", ctx.indent)
}

pub(super) fn figure(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let caption = query_tag(dom, el, "figcaption")
        .map(|c| js_trim(&dom.text_content(c)).to_owned())
        .unwrap_or_default();
    if let Some(img) = query_tag(dom, el, "img") {
        return media_figure(
            "img",
            dom.attr(img, "src").unwrap_or(""),
            dom.attr(img, "alt").unwrap_or(""),
            &caption,
            ctx,
        );
    }
    if let Some(video) = query_tag(dom, el, "video") {
        let (src, name) = video_source(dom, video);
        return media_figure("video", src, name, &caption, ctx);
    }
    if let Some(audio) = query_tag(dom, el, "audio") {
        return media_figure(
            "audio",
            dom.attr(audio, "src").unwrap_or(""),
            "",
            &caption,
            ctx,
        );
    }
    if let Some(link) = query_tag(dom, el, "a") {
        return block_link(dom, link, ctx);
    }
    String::new()
}

fn media_figure(kind: &str, src: &str, descriptor: &str, caption: &str, ctx: &Ctx) -> String {
    if src.is_empty() {
        return String::new();
    }
    if caption.is_empty() && kind != "audio" {
        return format!("{}![{descriptor}]({src})\n\n", ctx.indent);
    }
    let show = !descriptor.is_empty() && descriptor != caption;
    let attr = if !show {
        String::new()
    } else {
        match kind {
            "img" => format!(" alt=\"{}\"", escape_html_attr(descriptor)),
            "video" => format!(" data-name=\"{}\"", escape_html_attr(descriptor)),
            _ => String::new(),
        }
    };
    let src = escape_html_attr(src);
    let media = if kind == "img" {
        format!("<img{attr} src=\"{src}\">")
    } else {
        format!("<{kind} src=\"{src}\"{attr} controls></{kind}>")
    };
    let caption = if caption.is_empty() {
        String::new()
    } else {
        format!("<figcaption>{}</figcaption>", escape_html_text(caption))
    };
    format!("{}<figure>{media}{caption}</figure>\n\n", ctx.indent)
}

pub(super) fn block_link(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let href = dom.attr(el, "href").unwrap_or("");
    let text = js_trim(&dom.text_content(el)).to_owned();
    if href.is_empty() {
        return format!("{}{text}\n\n", ctx.indent);
    }
    format!("{}{}\n\n", ctx.indent, format_link(&text, href))
}

pub(super) fn details(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let Some(summary) = query_tag(dom, el, "summary") else {
        return serialize_children(dom, el, ctx);
    };
    let heading_el = dom.descendants(summary).into_iter().find(|d| {
        *d != summary
            && dom.is_element(*d)
            && matches!(
                tag(dom, *d).as_str(),
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
            )
    });
    if let Some(h) = heading_el {
        let mut result = heading(dom, h, ctx);
        for child in element_children(dom, el) {
            if child != summary {
                result.push_str(&serialize_node(dom, child, ctx));
            }
        }
        return result;
    }
    serialize_children(dom, summary, ctx)
}

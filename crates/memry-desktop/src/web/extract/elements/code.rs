//! `codeBlockRules` of `dist/elements/code.js`: every code block and syntax highlighter
//! container becomes `<pre><code data-lang class="language-x">text</code></pre>`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{is_js_whitespace, trim, utf16_len, utf16_slice};
use crate::web::extract::utils::text::count_words;

use super::code_lang::get_code_language;
use super::rule::Rule;

const SELECTOR: &str = "pre, div[class*=\"prismjs\"], .syntaxhighlighter, .highlight, .highlight-source, .wp-block-syntaxhighlighter-code, .wp-block-code, div[class*=\"language-\"], .code-block[data-lang], code.hl.block";

pub const RULES: &[Rule] = &[Rule {
    selector: SELECTOR,
    fast_check: None,
    transform: code_block,
}];

const LINE_SELECTOR: &str =
    "div[class*=\"line\"], span[class*=\"line\"], .ec-line, [data-line-number], [data-line]";

/// `/^\d+$/`.
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+$").expect("static pattern"));
/// `/\n{3,}/g`.
static NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").expect("static pattern"));

fn text_of(doc: &Document, el: NodeId) -> String {
    doc.text_content(el).unwrap_or_default()
}

/// `s.replace(/\n$/, '')`.
fn strip_one_newline(s: &str) -> &str {
    s.strip_suffix('\n').unwrap_or(s)
}

/// `extractWordPressContent(element)`.
fn extract_wordpress_content(doc: &Document, element: NodeId) -> Result<String, ExtractError> {
    let line_text = |line: NodeId| -> Result<String, ExtractError> {
        let mut parts = String::new();
        for code in doc.query_selector_all(line, "code")? {
            let mut text = text_of(doc, code);
            if doc.class_list_contains(code, "spaces") {
                text = " ".repeat(utf16_len(&text));
            }
            parts.push_str(&text);
        }
        Ok(if parts.is_empty() {
            text_of(doc, line)
        } else {
            parts
        })
    };
    if let Some(container) =
        doc.query_selector(element, ".syntaxhighlighter table .code .container")?
    {
        let mut lines = Vec::new();
        for line in doc.children(container) {
            lines.push(line_text(line)?);
        }
        return Ok(lines.join("\n"));
    }
    let code_lines = doc.query_selector_all(element, ".code .line")?;
    if code_lines.is_empty() {
        return Ok(String::new());
    }
    let mut lines = Vec::new();
    for line in code_lines {
        let mut parts = String::new();
        for code in doc.query_selector_all(line, "code")? {
            parts.push_str(&text_of(doc, code));
        }
        lines.push(if parts.is_empty() {
            text_of(doc, line)
        } else {
            parts
        });
    }
    Ok(lines.join("\n"))
}

/// `extractStructuredText(element)`.
fn extract_structured_text(doc: &Document, node: NodeId) -> Result<String, ExtractError> {
    match doc.node(node).kind {
        NodeKind::Text(_) => {
            // Whitespace between line spans: the line handling adds one newline per line.
            if let Some(parent) = doc.parent_element(node)
                && doc.query_selector(parent, "[data-line], .line")?.is_some()
                && trim(&text_of(doc, node)).is_empty()
            {
                return Ok(String::new());
            }
            return Ok(text_of(doc, node));
        }
        NodeKind::Element(_) => {}
        _ => return Ok(String::new()),
    }
    if doc.matches(node, ".hover-info, .hover-container")? {
        return Ok(String::new());
    }
    let tag = doc.tag_name(node).unwrap_or_default();
    if tag == "BUTTON" || tag == "STYLE" {
        return Ok(String::new());
    }
    if tag == "BR" {
        if let Some(prev) = doc.previous_element_sibling(node)
            && doc.matches(prev, LINE_SELECTOR)?
        {
            return Ok(String::new());
        }
        return Ok("\n".to_string());
    }
    if doc.matches(node, "span.lnt")?
        || doc.matches(node, "span.lineno")?
        || doc.matches(node, ".react-syntax-highlighter-line-number")?
        || doc.matches(node, ".rouge-gutter")?
    {
        return Ok(String::new());
    }
    if (tag == "DIV" || tag == "SPAN") && doc.child_element_count(node) == 2 {
        let kids = doc.children(node);
        if DIGITS.is_match(trim(&text_of(doc, kids[0]))) {
            let inner = extract_structured_text(doc, kids[1])?;
            return Ok(format!("{}\n", strip_one_newline(&inner)));
        }
    }
    if doc.matches(node, LINE_SELECTOR)? {
        if let Some(container) = doc.query_selector(
            node,
            ".code:not(.token), .content:not(.token), [class*=\"code-\"], [class*=\"content-\"]",
        )? {
            return Ok(format!("{}\n", strip_one_newline(&text_of(doc, container))));
        }
        if let Some(line_number) = doc.query_selector(
            node,
            ".line-number, .gutter, [class*=\"line-number\"], [class*=\"gutter\"]",
        )? {
            let mut joined = String::new();
            for child in doc.child_nodes(node) {
                if !doc.contains(line_number, child) {
                    joined.push_str(&extract_structured_text(doc, child)?);
                }
            }
            return Ok(format!("{}\n", strip_one_newline(&joined)));
        }
        return Ok(format!("{}\n", strip_one_newline(&text_of(doc, node))));
    }
    let mut text = String::new();
    for child in doc.child_nodes(node) {
        text.push_str(&extract_structured_text(doc, child)?);
    }
    Ok(text)
}

/// The cleanup of the Verso block: spaces and tabs at the ends, tabs, nbsp, leading newlines.
fn clean_verso(content: &str) -> String {
    let trimmed = content
        .trim_start_matches([' ', '\t'])
        .trim_end_matches([' ', '\t']);
    trimmed
        .replace('\t', "    ")
        .replace('\u{a0}', " ")
        .trim_start_matches('\n')
        .to_string()
}

/// Tabs, nbsp, the common indent, the ends and runs of blank lines.
fn clean_code(content: &str) -> String {
    let mut content = content.replace('\t', "    ").replace('\u{a0}', " ");
    let lines: Vec<&str> = content.split('\n').collect();
    let mut min_indent = usize::MAX;
    for line in &lines {
        // `line.search(/\S/)`, in UTF-16 units.
        let mut offset = 0;
        for c in line.chars() {
            if !is_js_whitespace(c) {
                min_indent = min_indent.min(offset);
                break;
            }
            offset += c.len_utf16();
        }
    }
    if min_indent == usize::MAX {
        min_indent = 0;
    }
    if min_indent > 0 {
        content = lines
            .iter()
            .map(|line| utf16_slice(line, min_indent, utf16_len(line)))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let trimmed = trim(&content);
    let collapsed = NEWLINES.replace_all(trimmed, "\n\n");
    collapsed
        .trim_start_matches('\n')
        .trim_end_matches('\n')
        .to_string()
}

fn code_block(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    for button in doc.query_selector_all(el, "button, [class*=\"codeblock-button\"]")? {
        doc.remove(button);
    }
    for header in doc.query_selector_all(
        el,
        "[class*=\"header\"], [class*=\"toolbar\"], [class*=\"titlebar\"], [class*=\"title-bar\"]",
    )? {
        let tag = doc.tag_name(header).unwrap_or_default();
        if tag != "DIV" && tag != "SPAN" {
            continue;
        }
        if let Some(line_ancestor) = doc.closest(header, "[data-line], .line")?
            && doc.contains(el, line_ancestor)
        {
            continue;
        }
        if doc
            .query_selector(header, "[data-line], .line, pre")?
            .is_some()
        {
            continue;
        }
        if count_words(trim(&text_of(doc, header))) <= 5 {
            doc.remove(header);
        }
    }

    let mut language = String::new();
    let mut current = Some(el);
    while let Some(c) = current {
        if !language.is_empty() {
            break;
        }
        language = get_code_language(doc, c);
        if language.is_empty() && c == el {
            let code_el =
                match doc.query_selector(c, "code[data-lang], code[class*=\"language-\"]")? {
                    Some(found) => Some(found),
                    None => doc.query_selector(c, "code")?,
                };
            if let Some(code_el) = code_el {
                language = get_code_language(doc, code_el);
            }
        }
        current = doc.parent_element(c);
    }

    let cm_content = doc.query_selector(el, ".cm-content")?;
    if let Some(cm) = cm_content
        && language.is_empty()
    {
        for div in doc.query_selector_all(el, "div")? {
            if doc.contains(div, cm) {
                continue;
            }
            let text = crate::web::extract::utils::js::to_lower(trim(&text_of(doc, div)));
            if !text.is_empty() && is_known_language(&text) {
                language = text;
                break;
            }
        }
    }

    let mut code_content = String::new();
    if doc.matches(el, ".syntaxhighlighter, .wp-block-syntaxhighlighter-code")? {
        code_content = extract_wordpress_content(doc, el)?;
    }
    if code_content.is_empty() && cm_content.is_some() {
        code_content = extract_structured_text(doc, cm_content.unwrap_or(el))?;
    } else if code_content.is_empty() {
        let mut target = el;
        let tag = doc.tag_name(el).unwrap_or_default();
        if tag != "PRE" && tag != "CODE" {
            let pres = doc.query_selector_all(el, "pre")?;
            let mut code_pre = None;
            for &p in &pres {
                if doc
                    .query_selector(
                        p,
                        "code[data-lang], code[class*=\"language-\"], .line, [data-line]",
                    )?
                    .is_some()
                {
                    code_pre = Some(p);
                    break;
                }
            }
            if code_pre.is_none() {
                for &p in &pres {
                    if doc.query_selector(p, "span[class]")?.is_some()
                        && !doc.class_list_contains(p, "lineno")
                    {
                        code_pre = Some(p);
                        break;
                    }
                }
            }
            if let Some(p) = code_pre {
                target = p;
            }
        }
        code_content = extract_structured_text(doc, target)?;
    }

    let is_verso = doc.matches(el, "code.hl.block")?;
    let code_content = if is_verso {
        clean_verso(&code_content)
    } else {
        clean_code(&code_content)
    };

    // Header and toolbar siblings of a tight code block wrapper are chrome, not content.
    let mut ancestor = Some(el);
    for _ in 0..3 {
        let Some(a) = ancestor else { break };
        let Some(container) = doc.parent_element(a) else {
            break;
        };
        if doc.tag_name(container).as_deref() == Some("BODY") {
            break;
        }
        if doc.child_element_count(container) > 5 {
            break;
        }
        if doc.closest(container, "[data-callout]")?.is_some() {
            break;
        }
        for sib in doc.children(container) {
            if doc.contains(sib, el) {
                continue;
            }
            let tag = doc.tag_name(sib).unwrap_or_default();
            if tag != "DIV" && tag != "SPAN" {
                continue;
            }
            let words = count_words(trim(&text_of(doc, sib)));
            if words <= 5
                && doc
                    .query_selector(
                        sib,
                        "pre, code, img, svg, table, h1, h2, h3, h4, h5, h6, p, blockquote, ul, ol, hr",
                    )?
                    .is_none()
            {
                doc.remove(sib);
            }
        }
        ancestor = Some(container);
    }

    let new_pre = doc.create_element("pre");
    if doc.matches(el, "code.hl.block, pre.hl.lean.lean-output")? {
        doc.set_attribute(new_pre, "data-verso-code", "true");
    }
    let code = doc.create_element("code");
    if !language.is_empty() {
        doc.set_attribute(code, "data-lang", &language);
        doc.set_attribute(code, "class", &format!("language-{language}"));
    }
    doc.set_text_content(code, &code_content)?;
    doc.append_child(new_pre, code)?;
    Ok(new_pre)
}

fn is_known_language(name: &str) -> bool {
    super::code_lang::is_language(name)
}

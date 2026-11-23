//! Inline runs to markdown, in the on-disk forms of chapter 12 §12.7.
//!
//! Readable first: a run of text that only changed colour is one span, the
//! whitespace on a styled run's edges sits outside its delimiters, and
//! markdown punctuation in the text is escaped so it reads back as text.
//! Colours have no markdown form and are left out.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value};

use crate::crdt::blocks::InlineRun;

const NODES: [&str; 7] = [
    "wikiLink",
    "hashTag",
    "dateMention",
    "linkMention",
    "inlineImage",
    "inlineCheckbox",
    "htmlComment",
];

/// The marks a text run is written with.
#[derive(PartialEq, Eq, Default)]
struct Style {
    bold: bool,
    italic: bool,
    strike: bool,
    underline: bool,
    code: bool,
    link: Option<String>,
}

/// `runs` as one line of markdown (hard breaks included). `in_table` escapes
/// the cell separator.
pub(super) fn render(runs: &[InlineRun], in_table: bool) -> String {
    let mut out = String::new();
    let mut index = 0;
    while index < runs.len() {
        if let Some(node) = node_of(&runs[index]) {
            out.push_str(&token(node, &runs[index], in_table));
            index += 1;
            continue;
        }
        let style = style_of(&runs[index]);
        let mut text = String::new();
        while index < runs.len()
            && node_of(&runs[index]).is_none()
            && style_of(&runs[index]) == style
        {
            text.push_str(&runs[index].text);
            index += 1;
        }
        let at_line_start = out.is_empty() || out.ends_with('\n');
        out.push_str(&styled(&text, &style, in_table, at_line_start));
    }
    out
}

/// The text of `runs` with no markdown, for a code block or a diagram.
pub(super) fn literal(runs: &[InlineRun]) -> String {
    runs.iter().map(|run| run.text.as_str()).collect()
}

fn node_of(run: &InlineRun) -> Option<&str> {
    run.marks
        .iter()
        .map(String::as_str)
        .find(|mark| NODES.contains(mark))
}

fn style_of(run: &InlineRun) -> Style {
    let has = |name: &str| run.marks.iter().any(|mark| mark == name);
    Style {
        bold: has("bold"),
        italic: has("italic"),
        strike: has("strike"),
        underline: has("underline"),
        code: has("code"),
        link: has("link").then(|| {
            run.mark_attrs
                .get("link.href")
                .or(run.target.as_ref())
                .cloned()
                .unwrap_or_default()
        }),
    }
}

fn styled(text: &str, style: &Style, in_table: bool, at_line_start: bool) -> String {
    if text.is_empty() {
        return String::new();
    }
    let body = if style.code {
        code_span(text)
    } else {
        escape(text, in_table, at_line_start)
    };
    let lead = body.len() - body.trim_start_matches([' ', '\t']).len();
    let trail = body.len() - body.trim_end_matches([' ', '\t']).len();
    if lead == body.len() {
        return body;
    }
    let mut core = body[lead..body.len() - trail].to_owned();
    if style.underline {
        core = format!("<u>{core}</u>");
    }
    if style.strike {
        core = format!("~~{core}~~");
    }
    if style.italic {
        core = format!("*{core}*");
    }
    if style.bold {
        core = format!("**{core}**");
    }
    if let Some(href) = &style.link {
        core = format!("[{core}]({href})");
    }
    format!("{}{core}{}", &body[..lead], &body[body.len() - trail..])
}

/// A code span whose fence is longer than any backtick run inside it.
fn code_span(text: &str) -> String {
    let text = text.replace('\n', " ");
    let longest = text
        .split(|c| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{fence}{pad}{text}{pad}{fence}")
}

/// Text that reads back as itself. A line break is a hard break.
fn escape(text: &str, in_table: bool, at_line_start: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    // Where the current line began, when this text began it, and whether
    // everything since is a digit (`1.` opening a line is a numbered list).
    let mut begin = at_line_start.then_some(0);
    let mut digits_only = true;
    for (index, &c) in chars.iter().enumerate() {
        if c == '\n' {
            out.push_str(if in_table { "<br>" } else { "\\\n" });
            begin = Some(index + 1);
            digits_only = true;
            continue;
        }
        let prev = index.checked_sub(1).and_then(|at| chars.get(at)).copied();
        let next = chars.get(index + 1).copied();
        let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
        let line_start = begin == Some(index);
        let escaped = match c {
            '\\' | '`' | '*' | '[' | ']' | '<' | '~' => true,
            '_' => !(word(prev) && word(next)),
            '#' => line_start || (!word(prev) && word(next)),
            '|' => in_table,
            '>' | '-' | '+' | '=' => line_start,
            '.' | ')' => digits_only && begin.is_some_and(|start| index > start),
            _ => false,
        };
        if escaped {
            out.push('\\');
        }
        out.push(c);
        digits_only = digits_only && c.is_ascii_digit();
    }
    out
}

fn attr<'a>(run: &'a InlineRun, node: &str, name: &str) -> Option<&'a str> {
    run.mark_attrs
        .get(&format!("{node}.{name}"))
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

fn token(node: &str, run: &InlineRun, in_table: bool) -> String {
    let target = attr(run, node, "target")
        .or(run.target.as_deref())
        .unwrap_or_default();
    match node {
        "wikiLink" => {
            let separator = if in_table { "\\|" } else { "|" };
            let link = match attr(run, node, "alias") {
                Some(alias) if alias != target => format!("[[{target}{separator}{alias}]]"),
                _ => format!("[[{target}]]"),
            };
            let on = |name| attr(run, node, name) == Some("true");
            let link = if on("strike") {
                format!("~~{link}~~")
            } else {
                link
            };
            let link = if on("italic") {
                format!("*{link}*")
            } else {
                link
            };
            if on("bold") {
                format!("**{link}**")
            } else {
                link
            }
        }
        "hashTag" => attr(run, node, "tag")
            .or(run.target.as_deref())
            .map(|tag| format!("#{tag}"))
            .unwrap_or_default(),
        "dateMention" => date_token(run),
        "linkMention" => attr(run, node, "url")
            .or(run.target.as_deref())
            .map(|url| format!("((mention:{}))", encode_mention(url)))
            .unwrap_or_default(),
        "inlineImage" => {
            let src = attr(run, node, "src")
                .or(run.target.as_deref())
                .unwrap_or_default();
            let alt = attr(run, node, "alt").unwrap_or_default();
            match attr(run, node, "width").and_then(|width| width.parse::<f64>().ok()) {
                Some(width) if width > 0.0 => format!("![{alt}|{width}]({src})"),
                _ => format!("![{alt}]({src})"),
            }
        }
        "inlineCheckbox" if attr(run, node, "checked") == Some("true") => "[x]".to_owned(),
        "inlineCheckbox" => "[ ]".to_owned(),
        "htmlComment" => attr(run, node, "source").unwrap_or_default().to_owned(),
        _ => String::new(),
    }
}

/// `((date:<payload>))`: the pill's fields as JSON, base64 in the closed
/// alphabet (`serializeDateMentionToken`, `packages/shared/src/date-mention.ts`).
fn date_token(run: &InlineRun) -> String {
    let Some(date) = attr(run, "dateMention", "dateISO") else {
        return String::new();
    };
    let text = |name, fallback: &str| {
        Value::from(attr(run, "dateMention", name).unwrap_or(fallback))
    };
    let mut data = Map::new();
    data.insert("anchorId".to_owned(), text("anchorId", ""));
    data.insert("dateISO".to_owned(), Value::from(date));
    data.insert(
        "hasTime".to_owned(),
        Value::from(attr(run, "dateMention", "hasTime") == Some("true")),
    );
    data.insert("dateFormat".to_owned(), text("dateFormat", "relative"));
    data.insert("remind".to_owned(), text("remind", "none"));
    data.insert("timeFormat".to_owned(), text("timeFormat", "system"));
    let payload = STANDARD
        .encode(Value::Object(data).to_string())
        .replace('+', ",")
        .replace('/', ";")
        .trim_end_matches('=')
        .to_owned();
    format!("((date:{payload}))")
}

/// `encodeURIComponent` plus `! ' ( ) * ~ _`, so the token holds only
/// `[A-Za-z0-9.%-]` (`packages/editor-schema/src/inline/link-mention.ts:39-48`).
fn encode_mention(url: &str) -> String {
    url.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' => (byte as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn run(text: &str, marks: &[&str], attrs: &[(&str, &str)]) -> InlineRun {
        InlineRun {
            text: text.to_owned(),
            marks: marks.iter().map(|mark| (*mark).to_owned()).collect(),
            mark_attrs: attrs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect::<HashMap<_, _>>(),
            target: None,
        }
    }

    #[test]
    fn marks_wrap_the_text_and_leave_edge_spaces_outside() {
        let runs = [
            run("plain ", &[], &[]),
            run("bold ", &["bold"], &[]),
            run("red", &["bold", "textColor"], &[("textColor", "red")]),
            run(" and ", &[], &[]),
            run("docs", &["link"], &[("link.href", "https://e.com/a")]),
            run(" x`y", &["code"], &[]),
        ];
        assert_eq!(
            render(&runs, false),
            "plain **bold red** and [docs](https://e.com/a)`` x`y``"
        );
    }

    #[test]
    fn markdown_punctuation_in_text_stays_text() {
        let runs = [run("# 1. a*b _c snake_case [x] <b> ~\n2) next", &[], &[])];
        assert_eq!(
            render(&runs, false),
            "\\# 1. a\\*b \\_c snake_case \\[x\\] \\<b> \\~\\\n2\\) next"
        );
        assert_eq!(render(&[run("12. item", &[], &[])], false), "12\\. item");
        assert_eq!(render(&[run("- not a list", &[], &[])], false), "\\- not a list");
    }

    #[test]
    fn inline_nodes_use_desktops_tokens() {
        let runs = [
            run("", &["wikiLink"], &[("wikiLink.target", "Dune"), ("wikiLink.alias", "the book")]),
            run(" ", &[], &[]),
            run("", &["hashTag"], &[("hashTag.tag", "reading")]),
            run(" ", &[], &[]),
            run("", &["linkMention"], &[("linkMention.url", "https://e.com/a_b")]),
            run("", &["htmlComment"], &[("htmlComment.source", "<!-- hidden -->")]),
        ];
        assert_eq!(
            render(&runs, false),
            "[[Dune|the book]] #reading ((mention:https%3A%2F%2Fe.com%2Fa%5Fb))<!-- hidden -->"
        );
    }

    #[test]
    fn a_date_mention_is_the_base64_token() {
        let runs = [run(
            "",
            &["dateMention"],
            &[
                ("dateMention.anchorId", "a1"),
                ("dateMention.dateISO", "2026-08-14T09:00:00.000Z"),
                ("dateMention.hasTime", "false"),
            ],
        )];
        let token = render(&runs, false);
        let payload = token
            .strip_prefix("((date:")
            .and_then(|rest| rest.strip_suffix("))"))
            .expect("token");
        let json = decode_token(payload);
        assert_eq!(
            json,
            r#"{"anchorId":"a1","dateISO":"2026-08-14T09:00:00.000Z","hasTime":false,"dateFormat":"relative","remind":"none","timeFormat":"system"}"#
        );
    }

    fn decode_token(payload: &str) -> String {
        let mut base64 = payload.replace(',', "+").replace(';', "/");
        while base64.len() % 4 != 0 {
            base64.push('=');
        }
        String::from_utf8(STANDARD.decode(base64).expect("base64")).expect("utf8")
    }
}

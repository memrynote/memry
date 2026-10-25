//! The end-anchored field rules of `obsidian-tasks.ts`, the regexes built
//! from them, and the strip loop that peels fields off the tail of a line.
//!
//! The plugin's dataview rules open with a look-ahead (`(?=[^\]]+\])\[`) that
//! only ever succeeds for a matched pair (nothing in a field's value holds a
//! closing bracket or paren), so each is two plain regexes here, one per pair.

use std::ops::Range;
use std::sync::OnceLock;

use regex::Regex;

use super::recurrence::parse_recurrence;
use super::{ObsidianPriority, ObsidianTaskFields};
use crate::markdown::frontmatter::js::js_trim;

/// The JS `\s` class members, spelled out (Rust's `\s` is narrower).
pub(super) const JS_WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

const TASK_ID: &str = "[a-zA-Z0-9_-]+";
const DATE: &str = "([0-9]{4}-[0-9]{2}-[0-9]{2})";
const HASH_TAG: &str = r##"#[^ !@\#$%^\&*(),.?":{}|<>]+"##;

/// `HASH_TAGS` (global).
pub(super) fn hash_tags() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!("(?:^|[{JS_WS}]){HASH_TAG}")))
}

fn hash_tag_from_end() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!("(?:^|[{JS_WS}]){HASH_TAG}$")))
}

/// `BLOCK_LINK`.
pub(super) fn block_link() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(r" \^[a-zA-Z0-9-]+$"))
}

/// `TASK_LINE`.
pub(super) fn task_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        compile(&format!(
            r"^([{JS_WS}>]*)([-*+]|[0-9]+[.)]) +\[([^\n\r\x{{2028}}\x{{2029}}])\] *([^\n\r\x{{2028}}\x{{2029}}]*)"
        ))
    })
}

pub(super) fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).expect("the obsidian-tasks patterns are constants")
}

pub(super) fn has_tag_anywhere(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!("(?:^|[{JS_WS}]){HASH_TAG}")))
        .is_match(text)
}

/// The slots the strip loop fills.
#[derive(Clone, Copy)]
enum Apply {
    Priority,
    Date(DateField),
    Recurrence,
    OnCompletion,
    Id,
    DependsOn,
}

#[derive(Clone, Copy)]
enum DateField {
    Done,
    Cancelled,
    Due,
    Scheduled,
    Start,
    Created,
}

struct Rule {
    /// One regex for an emoji rule, the bracket and paren forms for a dataview rule.
    regexes: Vec<Regex>,
    apply: Apply,
}

impl Rule {
    /// The leftmost match and its first group.
    fn find<'t>(&self, text: &'t str) -> Option<(Range<usize>, &'t str)> {
        self.regexes
            .iter()
            .filter_map(|re| {
                let caps = re.captures(text)?;
                let whole = caps.get(0)?;
                let value = caps.get(1).map_or("", |m| m.as_str());
                Some((whole.range(), value))
            })
            .min_by_key(|(range, _)| range.start)
    }
}

fn field_rule(symbols: &str, value: &str, apply: Apply) -> Rule {
    let value = if value.is_empty() {
        String::new()
    } else {
        format!(" *{value}")
    };
    Rule {
        regexes: vec![compile(&format!("{symbols}\\x{{FE0F}}?{value}$"))],
        apply,
    }
}

fn inline_rule(inner: &str, apply: Apply) -> Rule {
    Rule {
        regexes: vec![
            compile(&format!(r"\[ *{inner} *\](?: *,)?$")),
            compile(&format!(r"\( *{inner} *\)(?: *,)?$")),
        ],
        apply,
    }
}

fn emoji_rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let id_sequence = format!("{TASK_ID}( *, *{TASK_ID} *)*");
        vec![
            field_rule("(🔺|⏫|🔼|🔽|⏬)", "", Apply::Priority),
            field_rule("✅", DATE, Apply::Date(DateField::Done)),
            field_rule("❌", DATE, Apply::Date(DateField::Cancelled)),
            field_rule("(?:📅|📆|🗓)", DATE, Apply::Date(DateField::Due)),
            field_rule("(?:⏳|⌛)", DATE, Apply::Date(DateField::Scheduled)),
            field_rule("🛫", DATE, Apply::Date(DateField::Start)),
            field_rule("➕", DATE, Apply::Date(DateField::Created)),
            field_rule("🔁", "([a-zA-Z0-9, !]+)", Apply::Recurrence),
            field_rule("🏁", "([a-zA-Z]+)", Apply::OnCompletion),
            field_rule("🆔", &format!("({TASK_ID})"), Apply::Id),
            field_rule("⛔", &format!("({id_sequence})"), Apply::DependsOn),
        ]
    })
}

fn dataview_rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let id_sequence = format!("{TASK_ID}( *, *{TASK_ID} *)*");
        vec![
            inline_rule(
                "priority:: *(highest|high|medium|low|lowest)",
                Apply::Priority,
            ),
            inline_rule(
                &format!("completion:: *{DATE}"),
                Apply::Date(DateField::Done),
            ),
            inline_rule(
                &format!("cancelled:: *{DATE}"),
                Apply::Date(DateField::Cancelled),
            ),
            inline_rule(&format!("due:: *{DATE}"), Apply::Date(DateField::Due)),
            inline_rule(
                &format!("scheduled:: *{DATE}"),
                Apply::Date(DateField::Scheduled),
            ),
            inline_rule(&format!("start:: *{DATE}"), Apply::Date(DateField::Start)),
            inline_rule(
                &format!("created:: *{DATE}"),
                Apply::Date(DateField::Created),
            ),
            inline_rule("repeat:: *([a-zA-Z0-9, !]+)", Apply::Recurrence),
            inline_rule("onCompletion:: *([a-zA-Z]+)", Apply::OnCompletion),
            inline_rule(&format!("id:: *({TASK_ID})"), Apply::Id),
            inline_rule(&format!("dependsOn:: *({id_sequence})"), Apply::DependsOn),
        ]
    })
}

pub(super) const EMOJI_SYMBOLS: [&str; 18] = [
    "🔺", "⏫", "🔼", "🔽", "⏬", "🛫", "➕", "⏳", "⌛", "📅", "📆", "🗓", "✅", "❌", "🔁", "🏁",
    "⛔", "🆔",
];

pub(super) const DATAVIEW_MARKER: &str = "::";

fn priority(text: &str) -> Option<ObsidianPriority> {
    Some(match text {
        "🔺" | "highest" => ObsidianPriority::Highest,
        "⏫" | "high" => ObsidianPriority::High,
        "🔼" | "medium" => ObsidianPriority::Medium,
        "🔽" | "low" => ObsidianPriority::Low,
        "⏬" | "lowest" => ObsidianPriority::Lowest,
        _ => return None,
    })
}

fn apply_rule(apply: Apply, value: &str, out: &mut ObsidianTaskFields) {
    match apply {
        Apply::Priority => out.priority = priority(value),
        Apply::Date(field) => {
            let slot = match field {
                DateField::Done => &mut out.done_date,
                DateField::Cancelled => &mut out.cancelled_date,
                DateField::Due => &mut out.due_date,
                DateField::Scheduled => &mut out.scheduled_date,
                DateField::Start => &mut out.start_date,
                DateField::Created => &mut out.created_date,
            };
            *slot = Some(value.to_owned());
        }
        Apply::Recurrence => {
            let text = js_trim(value);
            out.recurrence_text = Some(text.to_owned());
            out.recurrence = parse_recurrence(text);
        }
        Apply::OnCompletion => out.on_completion = Some(value.to_owned()),
        Apply::Id => out.id = Some(js_trim(value).to_owned()),
        Apply::DependsOn => {
            out.depends_on = value
                .replace(' ', "")
                .split(',')
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect();
        }
    }
}

fn without(text: &str, range: Range<usize>) -> String {
    format!("{}{}", &text[..range.start], &text[range.end..])
}

/// Every rule is end-anchored, so fields come off the tail one at a time and
/// the pass repeats until nothing more matches (at most 21 passes). The tables
/// a line cannot match are skipped outright.
pub(super) fn strip_fields(input: &str, out: &mut ObsidianTaskFields) -> String {
    let mut tables: Vec<&'static [Rule]> = Vec::new();
    if EMOJI_SYMBOLS.iter().any(|symbol| input.contains(symbol)) {
        tables.push(emoji_rules());
    }
    if input.contains(DATAVIEW_MARKER) {
        tables.push(dataview_rules());
    }

    let mut text = input.to_owned();
    let mut trailing_tags = String::new();
    let mut runs = 0;
    loop {
        let mut matched = false;
        for rules in &tables {
            for rule in *rules {
                let Some((range, value)) = rule.find(&text) else {
                    continue;
                };
                apply_rule(rule.apply, value, out);
                text = js_trim(&without(&text, range)).to_owned();
                matched = true;
            }
        }
        if let Some(found) = hash_tag_from_end().find(&text) {
            let name = js_trim(found.as_str()).to_owned();
            trailing_tags = if trailing_tags.is_empty() {
                name
            } else {
                format!("{name} {trailing_tags}")
            };
            text = js_trim(&without(&text, found.range())).to_owned();
            matched = true;
        }
        runs += 1;
        if !(matched && runs <= 20) {
            break;
        }
    }

    // Tags were peeled off the end only to reach the fields behind them; they
    // go back on the description.
    if !trailing_tags.is_empty() {
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&trailing_tags);
    }
    text
}

//! `maskCellCodeSpans`' whitespace half (`editor-schema/src/inline/cell-code-spans.ts`)
//! for a line outside a table.
//!
//! Desktop masks the code spans of **every** line that holds a pipe, not only
//! a table row's: each space and tab a span keeps becomes a placeholder, put
//! back after the repair that strips a block's leading blank. So `` ` |`é ``
//! keeps the space in its code text, while `` ` a`b `` drops it, whatever
//! either line is. A line with `[`, `]` or a tag other than `<br>` is left
//! alone, as there. The pipes it also hides change nothing outside a table.
//!
//! On a line with no pipe only a code span of spaces and tabs alone is
//! masked, for any line: a paragraph that held only such a span read back
//! empty, and the span was dropped with it.

use std::sync::LazyLock;

use crate::domain::journal_rules::js_trim;

use super::backtick_runs::BacktickRuns;
use super::mask_word::mask_word;
use super::table::unsafe_for_code_mask;

/// `maskCellCodeSpans`' placeholders, with the process's mask word: no source
/// text spells one.
pub(super) fn space_token() -> &'static str {
    static TOKEN: LazyLock<String> = LazyLock::new(|| format!("MEMRYCSP{}SX", mask_word()));
    &TOKEN
}

pub(super) fn tab_token() -> &'static str {
    static TOKEN: LazyLock<String> = LazyLock::new(|| format!("MEMRYCSP{}TX", mask_word()));
    &TOKEN
}

/// `text` with the whitespace of its code spans hidden: every span on a line
/// that holds a pipe, and a span of whitespace alone on any other line.
pub(super) fn keep_code_whitespace(text: &str) -> String {
    if !text.contains('`') {
        return text.to_owned();
    }
    text.split('\n')
        .map(|line| {
            if !line.contains('|') {
                mask_line(line, true)
            } else if !unsafe_for_code_mask(line) {
                mask_line(line, false)
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `maskLine`: a backslash skips the char after it, and a span closes on the
/// first run of exactly its length, from the run's first backtick or a later
/// one the parser retries from.
fn mask_line(line: &str, blank_only: bool) -> String {
    let chars: Vec<char> = line.chars().collect();
    let ticks = BacktickRuns::of_chars(&chars);
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            out.extend(&chars[i..i + 2]);
            i += 2;
            continue;
        }
        if chars[i] != '`' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let run = chars[i..].iter().take_while(|c| **c == '`').count();
        let Some((open, end)) = ticks.span_at(i, true) else {
            out.extend(&chars[i..i + run]);
            i += run;
            continue;
        };
        let close = end - (i + run - open);
        out.extend(&chars[i..i + run]);
        mask_content(&chars[i + run..close], blank_only, &mut out);
        out.extend(&chars[close..end]);
        i = end;
    }
    out
}

/// `maskCodeContent`: the one space on each side that CommonMark strips (the
/// content opens and closes with one, and holds something else) stays as it
/// is, so the parser still strips it.
fn mask_content(content: &[char], blank_only: bool, out: &mut String) {
    if blank_only && (content.is_empty() || content.iter().any(|c| !matches!(c, ' ' | '\t'))) {
        out.extend(content);
        return;
    }
    let text: String = content.iter().collect();
    let stripped = content.len() >= 2
        && content[0] == ' '
        && content[content.len() - 1] == ' '
        && !js_trim(&text).is_empty();
    let inner = if stripped {
        &content[1..content.len() - 1]
    } else {
        content
    };
    if stripped {
        out.push(' ');
    }
    for ch in inner {
        match ch {
            ' ' => out.push_str(space_token()),
            '\t' => out.push_str(tab_token()),
            other => out.push(*other),
        }
    }
    if stripped {
        out.push(' ');
    }
}

/// The text with every placeholder turned back into its whitespace.
pub(super) fn restore_code_whitespace(text: &str) -> String {
    text.replace(space_token(), " ").replace(tab_token(), "\t")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_line_with_a_pipe_hides_its_code_whitespace() {
        assert_eq!(keep_code_whitespace("` a`b"), "` a`b");
        assert_eq!(
            keep_code_whitespace("` a|`b"),
            format!("`{}a|`b", space_token())
        );
        assert_eq!(keep_code_whitespace("` a `|x"), "` a `|x");
        assert_eq!(keep_code_whitespace("` a`|[l](u)"), "` a`|[l](u)");
        assert_eq!(
            keep_code_whitespace("`\ta`\n` b|`"),
            format!("`\ta`\n`{}b|`", space_token())
        );
    }

    #[test]
    fn a_line_without_a_pipe_hides_only_a_span_of_whitespace_alone() {
        assert_eq!(
            keep_code_whitespace("x ` ` y"),
            format!("x `{}` y", space_token())
        );
        assert_eq!(
            keep_code_whitespace("`\t `"),
            format!("`{}{}`", tab_token(), space_token())
        );
        assert_eq!(keep_code_whitespace("`` ` ``"), "`` ` ``");
        assert_eq!(
            keep_code_whitespace("` a ` `  `"),
            format!("` a ` `{}{}`", space_token(), space_token())
        );
        assert_eq!(keep_code_whitespace("``"), "``");
    }
}

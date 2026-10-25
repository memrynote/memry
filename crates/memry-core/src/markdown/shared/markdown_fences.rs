//! Port of `packages/shared/src/markdown-fences.ts`: CommonMark fence tracking,
//! so a marker quoted inside a code block stays text.

use crate::markdown::frontmatter::js::js_trim;

/// `createFenceTracker`. A fence opens with 3+ of `` ` `` or `~` (up to 3
/// leading spaces) and closes only on the same character, at least as long,
/// with nothing after it.
#[derive(Default)]
pub struct FenceTracker {
    open: Option<(char, usize)>,
}

/// The JS pattern `^ {0,3}(`{3,}|~{3,})(.*)$`: `.` stops at a line terminator,
/// so a line holding one never matches.
fn fence_line(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = rest.chars().take_while(|c| *c == ch).count();
    if run < 3 {
        return None;
    }
    let info = &rest[run..];
    if info.chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
        return None;
    }
    Some((ch, run, info))
}

impl FenceTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when `line` is inside a fence, the opening and closing lines included.
    pub fn consume(&mut self, line: &str) -> bool {
        let Some((ch, len, info)) = fence_line(line) else {
            return self.open.is_some();
        };
        match self.open {
            None => {
                // An info string may not contain a backtick (CommonMark 4.5).
                if ch == '`' && info.contains('`') {
                    return false;
                }
                self.open = Some((ch, len));
            }
            Some((open_ch, open_len)) => {
                if ch == open_ch && len >= open_len && js_trim(info).is_empty() {
                    self.open = None;
                }
            }
        }
        true
    }
}

//! The CSV tokenizer Raindrop's, Todoist's and TickTick's exports share: `tokenizeCsv`
//! (`packages/importers/src/{raindrop,ticktick}/parse-csv.ts`) and `parseCsv`
//! (`packages/importers/src/todoist/parse-csv.ts`) read a file the same way. A quote anywhere
//! outside quotes opens a quoted run, `""` inside one is a quote, a CR outside quotes is
//! dropped, and an LF ends a row. The CSV importer's dialect differs (`csv.rs`).

use std::cell::Cell;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Steps of this thread's export readers: one per character [`lex`] reads, plus the steps each
/// importer counts for its own work per cell or row (Raindrop's tag pieces; Todoist's date
/// tokens and indent-stack probes; TickTick's list rows and order comparisons).
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

pub(super) fn step() {
    STEPS.with(|steps| steps.set(steps.get() + 1));
}

/// `tokenizeCsv`, one field at a time: `emit(Some(field))` for each field and `emit(None)` after
/// a row's last one. Stops when `emit` returns false.
pub(super) fn lex(text: &str, mut emit: impl FnMut(Option<&str>) -> bool) {
    let mut field = String::new();
    let mut fields_in_row = 0usize;
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        step();
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        let go_on = match c {
            '"' => {
                in_quotes = true;
                true
            }
            ',' => {
                fields_in_row += 1;
                emit(Some(&field))
            }
            '\r' => true,
            '\n' => {
                fields_in_row = 0;
                emit(Some(&field)) && emit(None)
            }
            _ => {
                field.push(c);
                true
            }
        };
        if c == ',' || c == '\n' {
            field.clear();
        }
        if !go_on {
            return;
        }
    }
    if !field.is_empty() || fields_in_row > 0 {
        let _ = emit(Some(&field)) && emit(None);
    }
}

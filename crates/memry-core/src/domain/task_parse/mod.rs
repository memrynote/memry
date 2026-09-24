//! Natural-language task input (spec 004 D1): dates, quick-add, repeat
//! phrases and ghost completion, pinned byte for byte by the `task-parsing`
//! vectors generated from `packages/domain-tasks/src/parsing`.
//!
//! English only, exactly as desktop has it today. Every function takes the
//! caller's local wall-clock `now` ([`crate::domain::calendar::LocalDateTime`]);
//! nothing here reads a clock. Span offsets are UTF-16 code units, as the
//! TypeScript they are pinned against indexes strings.

pub mod completion;
pub mod natural_date;
pub mod quick_add;
pub mod repeat_phrase;

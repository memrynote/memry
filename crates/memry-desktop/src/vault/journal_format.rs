//! Journal file names from dates and back, after `packages/storage-vault/src/journal-format.ts`.
//! The vectors in `tests/fixtures/journal-format.json` come from that file.
//!
//! A journal (daily note) file name is a date rendered with a format built from these tokens:
//! `YYYY` (4-digit year), `YY` (2-digit year), `MMMM` (`January`), `MMM` (`Jan`), `MM`
//! (2-digit month), `M` (1-2 digit month), `DD` (2-digit day), `D` (1-2 digit day), `dddd`
//! (`Saturday`), `ddd` (`Sat`). Everything else is a literal. A `/` is a folder separator:
//! `YYYY/MMMM/YYYY-MM-DD` files 2025-01-14 at `2025/January/2025-01-14`, relative to the
//! journal folder. A field may repeat across segments, and a path whose copies disagree
//! (`2025/02/2025-01-14`) is not a journal, so every date has one path.
//!
//! Names are always English, never the UI language: a file name has to parse back to the same
//! date after the user switches languages. A name whose weekday is not its date's is not a
//! journal either.
//!
//! The functions work on the name without `.md`; callers add the folder and the extension.
//! Electron's quirks are kept, since both apps read one vault: a day is checked against 1-31
//! only (`2025-02-31` parses, and its weekday is that of 3 March), and any year below 100 is
//! read as 20xx, from `YYYY` too (`0099` is 2099).

use std::fmt;

use regex::Regex;

use crate::web::extract::utils::js;

pub const DEFAULT_JOURNAL_DATE_FORMAT: &str = "YYYY-MM-DD";

const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Longest first, so `YYYY` wins over `YY`, `MMMM` over `MMM` over `MM`, and `MM` and `DD`
/// over `M` and `D`.
const TOKENS: [(&str, Token); 10] = [
    ("YYYY", Token::Year4),
    ("YY", Token::Year2),
    ("MMMM", Token::MonthName),
    ("MMM", Token::MonthShort),
    ("dddd", Token::WeekdayName),
    ("ddd", Token::WeekdayShort),
    ("MM", Token::Month2),
    ("DD", Token::Day2),
    ("M", Token::Month),
    ("D", Token::Day),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Year,
    Month,
    Day,
    Weekday,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    Year4,
    Year2,
    MonthName,
    MonthShort,
    Month2,
    Month,
    Day2,
    Day,
    WeekdayName,
    WeekdayShort,
}

impl Token {
    fn field(self) -> Field {
        match self {
            Self::Year4 | Self::Year2 => Field::Year,
            Self::MonthName | Self::MonthShort | Self::Month2 | Self::Month => Field::Month,
            Self::Day2 | Self::Day => Field::Day,
            Self::WeekdayName | Self::WeekdayShort => Field::Weekday,
        }
    }

    /// The token's capture, as `journal-format.ts` writes it; `[0-9]` because Rust's `\d`
    /// also takes non-ASCII digits, which JavaScript's does not.
    fn pattern(self) -> String {
        match self {
            Self::Year4 => "[0-9]{4}".to_owned(),
            Self::Year2 | Self::Month2 | Self::Day2 => "[0-9]{2}".to_owned(),
            Self::Month | Self::Day => "[0-9]{1,2}".to_owned(),
            Self::MonthName => MONTHS.join("|"),
            Self::MonthShort => MONTHS.map(short).join("|"),
            Self::WeekdayName => WEEKDAYS.join("|"),
            Self::WeekdayShort => WEEKDAYS.map(short).join("|"),
        }
    }

    fn render(self, date: JournalDate) -> String {
        let JournalDate { year, month, day } = date;
        let month_name = MONTHS[usize::from(month) - 1];
        let weekday_name = WEEKDAYS[weekday_of(year, month, day)];
        match self {
            Self::Year4 => format!("{year:04}"),
            Self::Year2 => format!("{:02}", year % 100),
            Self::MonthName => month_name.to_owned(),
            Self::MonthShort => short(month_name).to_owned(),
            Self::Month2 => format!("{month:02}"),
            Self::Month => month.to_string(),
            Self::Day2 => format!("{day:02}"),
            Self::Day => day.to_string(),
            Self::WeekdayName => weekday_name.to_owned(),
            Self::WeekdayShort => short(weekday_name).to_owned(),
        }
    }
}

fn short(name: &str) -> &str {
    &name[..3]
}

/// A journal's date. Month is 1-12 and day 1-31; a day past its month's end is kept as
/// Electron keeps it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JournalDate {
    year: u16,
    month: u8,
    day: u8,
}

impl JournalDate {
    /// `YYYY-MM-DD` with a month of 1-12 and a day of 1-31, the form [`fmt::Display`] writes.
    pub fn from_iso(iso: &str) -> Option<Self> {
        let bytes = iso.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let number = |part: &str| {
            part.bytes()
                .all(|b| b.is_ascii_digit())
                .then(|| part.parse::<u16>().ok())
                .flatten()
        };
        let (year, month, day) = (number(&iso[..4])?, number(&iso[5..7])?, number(&iso[8..])?);
        let (month, day) = (u8::try_from(month).ok()?, u8::try_from(day).ok()?);
        ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some(Self { year, month, day })
    }
}

impl fmt::Display for JournalDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

/// 0 (Sunday) to 6 (Saturday) of the proleptic Gregorian calendar, a day past its month's end
/// counting on into the next month, as JavaScript's `Date` does.
fn weekday_of(year: u16, month: u8, day: u8) -> usize {
    // Days from 1970-01-01 to the first of the month (Howard Hinnant's `days_from_civil`).
    let (year, month) = (i64::from(year), i64::from(month));
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468 + i64::from(day) - 1;
    // 1970-01-01 was a Thursday.
    (days + 4).rem_euclid(7) as usize
}

#[derive(Debug, Clone)]
enum Piece {
    Token(Token),
    Literal(char),
}

/// A format, compiled once for many names.
#[derive(Debug, Clone)]
pub struct JournalFormat {
    pieces: Vec<Piece>,
    /// `None` for a format too large to compile, which no name matches.
    regex: Option<Regex>,
}

impl JournalFormat {
    /// The empty format is the default one.
    pub fn new(format: &str) -> Self {
        let format = if format.is_empty() {
            DEFAULT_JOURNAL_DATE_FORMAT
        } else {
            format
        };
        let mut pieces = Vec::new();
        let mut rest = format;
        while let Some(first) = rest.chars().next() {
            match TOKENS.iter().find(|(text, _)| rest.starts_with(text)) {
                Some((text, token)) => {
                    pieces.push(Piece::Token(*token));
                    rest = &rest[text.len()..];
                }
                None => {
                    pieces.push(Piece::Literal(first));
                    rest = &rest[first.len_utf8()..];
                }
            }
        }
        let body: String = pieces
            .iter()
            .map(|piece| match piece {
                Piece::Token(token) => format!("({})", token.pattern()),
                Piece::Literal(ch) => regex::escape(ch.encode_utf8(&mut [0; 4])),
            })
            .collect();
        let regex = Regex::new(&format!("^{body}$"))
            .inspect_err(|error| {
                tracing::warn!(
                    scope = "journal_format",
                    "a journal date format matches no name: {error}"
                );
            })
            .ok();
        Self { pieces, regex }
    }

    /// The date a name (without `.md`) stands for, or `None` when it is not a journal's.
    pub fn parse(&self, stem: &str) -> Option<JournalDate> {
        let captures = self.regex.as_ref()?.captures(stem)?;
        let tokens = self.pieces.iter().filter_map(|piece| match piece {
            Piece::Token(token) => Some(*token),
            Piece::Literal(_) => None,
        });
        let mut values: [Option<u16>; 4] = [None; 4];
        for (token, raw) in tokens.zip(captures.iter().skip(1)) {
            let value = field_value(token, raw?.as_str())?;
            let slot = &mut values[token.field() as usize];
            // A field repeated across folder segments must agree with itself.
            if slot.is_some_and(|previous| previous != value) {
                return None;
            }
            *slot = Some(value);
        }
        let [year, month, day, weekday] = values;
        let (year, month, day) = (year?, month.unwrap_or(1), day.unwrap_or(1));
        let (month, day) = (u8::try_from(month).ok()?, u8::try_from(day).ok()?);
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        if weekday.is_some_and(|weekday| usize::from(weekday) != weekday_of(year, month, day)) {
            return None;
        }
        Some(JournalDate { year, month, day })
    }

    /// The name (without `.md`) of `date`'s journal.
    pub fn render(&self, date: JournalDate) -> String {
        self.pieces
            .iter()
            .map(|piece| match piece {
                Piece::Token(token) => token.render(date),
                Piece::Literal(ch) => ch.to_string(),
            })
            .collect()
    }
}

fn field_value(token: Token, raw: &str) -> Option<u16> {
    let index_in = |names: &[&str]| {
        names
            .iter()
            .position(|name| *name == raw || short(name) == raw)
            .and_then(|index| u16::try_from(index).ok())
    };
    match token {
        Token::WeekdayName | Token::WeekdayShort => index_in(&WEEKDAYS),
        Token::MonthName | Token::MonthShort => index_in(&MONTHS).map(|index| index + 1),
        _ => {
            let value: u16 = raw.parse().ok()?;
            Some(if token.field() == Field::Year && value < 100 {
                2000 + value
            } else {
                value
            })
        }
    }
}

/// Where a vault's journal days are: its journal folder and date format, normalized, the
/// format compiled once. The one owner of which day a vault path names (`isJournalEntry` and
/// `extractDateFromPath`, `database/queries/notes/journal-queries.ts`).
#[derive(Debug, Clone)]
pub struct JournalDays {
    /// The config's two values as given, to tell whether a config read later is the same.
    source: (String, String),
    folder: String,
    format: JournalFormat,
}

impl JournalDays {
    /// The days of a vault config's `journalFolder` and `journalDateFormat`.
    pub fn new(folder: &str, format: &str) -> Self {
        Self {
            source: (folder.to_owned(), format.to_owned()),
            folder: normalize_journal_folder(folder),
            format: JournalFormat::new(&normalize_journal_date_format(format)),
        }
    }

    /// Whether these are the days of that folder and format, as [`Self::new`] took them.
    pub fn is_of(&self, folder: &str, format: &str) -> bool {
        self.source.0 == folder && self.source.1 == format
    }

    /// The day `path` names (`YYYY-MM-DD`): a `.md` file under the journal folder whose path
    /// below it, without `.md`, parses in the format. No journal folder configured, the vault
    /// root, means no day.
    pub fn day_of(&self, path: &str) -> Option<String> {
        if self.folder.is_empty() {
            return None;
        }
        let below = path.strip_prefix(&self.folder)?.strip_prefix('/')?;
        let date = self.format.parse(below.strip_suffix(".md")?)?;
        Some(date.to_string())
    }
}

/// `parseJournalDate`.
pub fn parse_journal_date(stem: &str, format: &str) -> Option<JournalDate> {
    JournalFormat::new(format).parse(stem)
}

/// `formatJournalFilename`.
pub fn format_journal_filename(date: JournalDate, format: &str) -> String {
    JournalFormat::new(format).render(date)
}

/// The canonical form of a typed format: trimmed, a backslash read as a folder separator, and
/// no empty, `.` or `..` folder. The file name keeps its inner spaces (`YYYY-MM-DD dddd`).
pub fn normalize_journal_date_format(format: &str) -> String {
    clean_segments(format)
}

/// The canonical vault-relative journal folder, by the same rules: `/Daily Notes/` and
/// `Daily Notes` are one folder. `""` is the vault root, where no journal is ever detected.
pub fn normalize_journal_folder(folder: &str) -> String {
    clean_segments(folder)
}

fn clean_segments(value: &str) -> String {
    js::trim(value)
        .split(['/', '\\'])
        .map(js::trim)
        .filter(|segment| !matches!(*segment, "" | "." | ".."))
        .collect::<Vec<_>>()
        .join("/")
}

//! iCalendar text → components (RFC 5545 §3.1), and the value types the
//! calendar readers need: DATE / DATE-TIME, DURATION, TEXT.
//!
//! This is the part of `ical.js` desktop's feeds and CalDAV mirror lean on
//! (`ICAL.parse` + `ICAL.Component`): unfolded content lines, parameters with
//! quoted values, nested BEGIN / END blocks. Unknown components and
//! properties are kept, so a VEVENT's extras never break a read.

use crate::domain::calendar::CivilDate;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Property {
    /// Upper case.
    pub name: String,
    /// `(NAME, value)`, the name upper case, quotes removed.
    pub params: Vec<(String, String)>,
    pub value: String,
}

impl Property {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Component {
    /// Upper case (`VCALENDAR`, `VEVENT`, …).
    pub name: String,
    pub properties: Vec<Property>,
    pub children: Vec<Component>,
}

impl Component {
    pub fn first(&self, name: &str) -> Option<&Property> {
        self.properties.iter().find(|p| p.name == name)
    }

    pub fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Property> + 'a {
        self.properties.iter().filter(move |p| p.name == name)
    }

    pub fn has(&self, name: &str) -> bool {
        self.first(name).is_some()
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Component> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// `textProp`: the unescaped, trimmed value, `None` when blank.
    pub fn text(&self, name: &str) -> Option<String> {
        let value = unescape_text(&self.first(name)?.value);
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    }
}

/// The text is not an iCalendar object at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotACalendar;

/// `ICAL.parse` + the `vcalendar` check: the first top-level component, which
/// must be a VCALENDAR.
pub fn parse_calendar(text: &str) -> Result<Component, NotACalendar> {
    let mut stack: Vec<Component> = Vec::new();
    let mut roots: Vec<Component> = Vec::new();
    for line in unfold(text) {
        if line.trim().is_empty() {
            continue;
        }
        let property = parse_line(&line).ok_or(NotACalendar)?;
        match property.name.as_str() {
            "BEGIN" => stack.push(Component {
                name: property.value.trim().to_ascii_uppercase(),
                ..Component::default()
            }),
            "END" => {
                let done = stack.pop().ok_or(NotACalendar)?;
                if done.name != property.value.trim().to_ascii_uppercase() {
                    return Err(NotACalendar);
                }
                match stack.last_mut() {
                    Some(parent) => parent.children.push(done),
                    None => roots.push(done),
                }
            }
            _ => stack
                .last_mut()
                .ok_or(NotACalendar)?
                .properties
                .push(property),
        }
    }
    if !stack.is_empty() {
        return Err(NotACalendar);
    }
    roots
        .into_iter()
        .next()
        .filter(|root| root.name == "VCALENDAR")
        .ok_or(NotACalendar)
}

/// Content lines with folding undone (a line starting with a space or tab
/// continues the one before).
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = raw.strip_prefix([' ', '\t'])
            && let Some(last) = lines.last_mut()
        {
            last.push_str(rest);
            continue;
        }
        lines.push(raw.to_owned());
    }
    lines
}

/// `NAME;PARAM=a,"b;c":value`. `None` when there is no colon.
fn parse_line(line: &str) -> Option<Property> {
    let mut in_quotes = false;
    let mut split = None;
    for (index, ch) in line.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                split = Some(index);
                break;
            }
            _ => {}
        }
    }
    let split = split?;
    let (head, value) = (&line[..split], &line[split + 1..]);
    let mut parts = split_unquoted(head, ';').into_iter();
    let name = parts.next()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = parts
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((
                key.trim().to_ascii_uppercase(),
                value.trim().trim_matches('"').to_owned(),
            ))
        })
        .collect();
    Some(Property {
        name,
        params,
        value: value.to_owned(),
    })
}

fn split_unquoted(text: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut in_quotes = false;
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        if ch == '"' {
            in_quotes = !in_quotes;
        } else if ch == separator && !in_quotes {
            parts.push(&text[start..index]);
            start = index + ch.len_utf8();
        }
    }
    parts.push(&text[start..]);
    parts
}

/// TEXT unescaping (§3.3.11).
pub fn unescape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Where a DATE-TIME's wall time lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimeZoneRef {
    Utc,
    /// A `TZID` parameter.
    Named(String),
    Floating,
}

/// A DATE or DATE-TIME value as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IcalTime {
    pub date: CivilDate,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub is_date: bool,
    pub zone: TimeZoneRef,
}

impl IcalTime {
    /// Seconds since the epoch, reading the wall fields as if they were UTC.
    pub fn wall_seconds(&self) -> i64 {
        self.date.days_since_epoch() * 86_400
            + i64::from(self.hour) * 3_600
            + i64::from(self.minute) * 60
            + i64::from(self.second)
    }

    /// The same zone and kind at other wall fields.
    pub fn with_wall_seconds(&self, seconds: i64) -> Self {
        let day = seconds.div_euclid(86_400);
        let rest = seconds.rem_euclid(86_400);
        Self {
            date: CivilDate::from_days_since_epoch(day),
            hour: u32::try_from(rest / 3_600).unwrap_or(0),
            minute: u32::try_from(rest % 3_600 / 60).unwrap_or(0),
            second: u32::try_from(rest % 60).unwrap_or(0),
            is_date: self.is_date,
            zone: self.zone.clone(),
        }
    }
}

/// A property's DATE / DATE-TIME value (the first when it lists several).
pub fn time_of(property: &Property) -> Option<IcalTime> {
    let first = property.value.split(',').next()?;
    parse_time(first, property)
}

/// Every value of a multi-valued EXDATE / RDATE line.
pub fn times_of(property: &Property) -> Vec<IcalTime> {
    property
        .value
        .split(',')
        .filter_map(|value| parse_time(value, property))
        .collect()
}

fn parse_time(raw: &str, property: &Property) -> Option<IcalTime> {
    let raw = raw.trim();
    let date_part = raw.get(..8)?;
    let date = CivilDate::new(
        date_part.get(..4)?.parse().ok()?,
        date_part.get(4..6)?.parse().ok()?,
        date_part.get(6..8)?.parse().ok()?,
    )?;
    let value_is_date = property
        .param("VALUE")
        .is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
    if raw.len() == 8 || value_is_date {
        return Some(IcalTime {
            date,
            hour: 0,
            minute: 0,
            second: 0,
            is_date: true,
            zone: TimeZoneRef::Floating,
        });
    }
    let time = raw.get(9..)?;
    let utc = time.ends_with(['Z', 'z']);
    let digits = time.trim_end_matches(['Z', 'z']);
    let zone = if utc {
        TimeZoneRef::Utc
    } else if let Some(tzid) = property.param("TZID") {
        TimeZoneRef::Named(tzid.trim_start_matches('/').to_owned())
    } else {
        TimeZoneRef::Floating
    };
    Some(IcalTime {
        date,
        hour: digits.get(..2)?.parse().ok().filter(|h| *h < 24)?,
        minute: digits.get(2..4)?.parse().ok().filter(|m| *m < 60)?,
        second: digits
            .get(4..6)
            .and_then(|s| s.parse().ok())
            .map_or(0, |s: u32| s.min(59)),
        is_date: false,
        zone,
    })
}

/// `[+|-]P[nW][nD][T[nH][nM][nS]]` in seconds.
pub fn parse_duration(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (sign, rest) = match raw.as_bytes().first()? {
        b'-' => (-1, &raw[1..]),
        b'+' => (1, &raw[1..]),
        _ => (1, raw),
    };
    let rest = rest.strip_prefix(['P', 'p'])?;
    let mut total = 0_i64;
    let mut number = String::new();
    let mut in_time = false;
    let mut any = false;
    for ch in rest.chars() {
        match ch.to_ascii_uppercase() {
            'T' => in_time = true,
            digit @ '0'..='9' => number.push(digit),
            unit => {
                let value: i64 = number.parse().ok()?;
                number.clear();
                any = true;
                total += value
                    * match (unit, in_time) {
                        ('W', false) => 604_800,
                        ('D', false) => 86_400,
                        ('H', true) => 3_600,
                        ('M', true) => 60,
                        ('S', true) => 1,
                        _ => return None,
                    };
            }
        }
    }
    (any && number.is_empty()).then_some(sign * total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folded_lines_quoted_params_and_nesting() {
        let text = "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Team\r\nBEGIN:VEVENT\r\nSUMMARY:Long\r\n  title\r\nDTSTART;TZID=\"America/New_York\":20260301T090000\r\nDESCRIPTION:a\\, b\\nc\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let root = parse_calendar(text).expect("calendar");
        assert_eq!(root.text("X-WR-CALNAME").as_deref(), Some("Team"));
        let event = root.children_named("VEVENT").next().expect("event");
        assert_eq!(event.text("SUMMARY").as_deref(), Some("Long title"));
        assert_eq!(event.text("DESCRIPTION").as_deref(), Some("a, b\nc"));
        let start = time_of(event.first("DTSTART").expect("dtstart")).expect("time");
        assert_eq!(start.zone, TimeZoneRef::Named("America/New_York".into()));
        assert_eq!((start.hour, start.minute), (9, 0));
    }

    #[test]
    fn not_a_calendar() {
        assert_eq!(parse_calendar("hello"), Err(NotACalendar));
        assert_eq!(
            parse_calendar("BEGIN:VCARD\nEND:VCARD\n"),
            Err(NotACalendar)
        );
        assert_eq!(parse_calendar("BEGIN:VCALENDAR\n"), Err(NotACalendar));
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(5_400));
        assert_eq!(parse_duration("P1D"), Some(86_400));
        assert_eq!(parse_duration("-PT15M"), Some(-900));
        assert_eq!(parse_duration("P2W"), Some(1_209_600));
        assert_eq!(parse_duration("PT"), None);
        assert_eq!(parse_duration("1H"), None);
    }
}

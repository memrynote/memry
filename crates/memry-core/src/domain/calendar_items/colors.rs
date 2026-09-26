//! `packages/contracts/src/calendar-colors.ts`: Google's palettes.

/// Calendar colours in Google's calendar colour id order ("1".."24"), with
/// the hex Google Calendar shows today and the legacy API `backgroundColor`.
const CALENDAR_COLORS: [(&str, &str, &str); 24] = [
    ("cocoa", "#795548", "#ac725e"),
    ("flamingo", "#e67c73", "#d06b64"),
    ("tomato", "#d50000", "#f83a22"),
    ("tangerine", "#f4511e", "#fa573c"),
    ("pumpkin", "#ef6c00", "#ff7537"),
    ("mango", "#f09300", "#ffad46"),
    ("eucalyptus", "#009688", "#42d692"),
    ("basil", "#0b8043", "#16a765"),
    ("pistachio", "#7cb342", "#7bd148"),
    ("avocado", "#c0ca33", "#b3dc6c"),
    ("citron", "#e4c441", "#fbe983"),
    ("banana", "#f6bf26", "#fad165"),
    ("sage", "#33b679", "#92e1c0"),
    ("peacock", "#039be5", "#9fe1e7"),
    ("cobalt", "#4285f4", "#9fc6e7"),
    ("blueberry", "#3f51b5", "#4986e7"),
    ("lavender", "#7986cb", "#9a9cff"),
    ("wisteria", "#b39ddb", "#b99aff"),
    ("graphite", "#616161", "#c2c2c2"),
    ("birch", "#a79b8e", "#cabdbf"),
    ("radicchio", "#ad1457", "#cca6ac"),
    ("cherry-blossom", "#d81b60", "#f691b2"),
    ("grape", "#8e24aa", "#cd74e6"),
    ("amethyst", "#9e69af", "#a47ae2"),
];

/// `CALENDAR_EVENT_COLORS` in menu order, with Google's event colour id.
pub const EVENT_COLORS: [(&str, &str); 11] = [
    ("tomato", "11"),
    ("flamingo", "4"),
    ("tangerine", "6"),
    ("banana", "5"),
    ("sage", "2"),
    ("basil", "10"),
    ("peacock", "7"),
    ("blueberry", "9"),
    ("lavender", "1"),
    ("grape", "3"),
    ("graphite", "8"),
];

/// `calendarEventColorFromColorId`.
pub fn event_color_from_id(color_id: Option<&str>) -> Option<&'static str> {
    let id = color_id.filter(|id| !id.is_empty())?;
    EVENT_COLORS
        .iter()
        .find(|(_, cid)| *cid == id)
        .map(|(name, _)| *name)
}

/// `colorIdForCalendarEventColor`.
pub fn color_id_for_event_color(color: Option<&str>) -> Option<&'static str> {
    let color = color?;
    EVENT_COLORS
        .iter()
        .find(|(name, _)| *name == color)
        .map(|(_, id)| *id)
}

/// `calendarColorHex`.
pub fn calendar_color_hex(color: &str) -> Option<&'static str> {
    CALENDAR_COLORS
        .iter()
        .find(|(name, _, _)| *name == color)
        .map(|(_, hex, _)| *hex)
}

/// `calendarDisplayHex`: a palette colour's current hex, a custom `#rrggbb`
/// as itself, anything else none.
pub fn display_hex(stored: Option<&str>) -> Option<String> {
    let hex = stored?.trim().to_lowercase();
    let valid = hex.len() == 7
        && hex.starts_with('#')
        && hex[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return None;
    }
    Some(
        CALENDAR_COLORS
            .iter()
            .find(|(_, _, legacy)| *legacy == hex)
            .map_or(hex.clone(), |(_, current, _)| (*current).to_owned()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_hexes_read_as_googles_current_ones() {
        assert_eq!(display_hex(Some("#9FC6E7")).as_deref(), Some("#4285f4"));
        assert_eq!(display_hex(Some("#123abc")).as_deref(), Some("#123abc"));
        assert_eq!(display_hex(Some("blue")), None);
        assert_eq!(event_color_from_id(Some("11")), Some("tomato"));
        assert_eq!(color_id_for_event_color(Some("lavender")), Some("1"));
    }
}

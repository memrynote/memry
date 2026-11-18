//! `stickies/text.ts`: how sticky text splits into a title and a body.

/// The first line of the trimmed text is the title; whatever follows it, trimmed, is the body.
pub fn split(text: &str) -> (&str, &str) {
    let trimmed = text.trim();
    match trimmed.split_once('\n') {
        Some((first, rest)) => (first.trim(), rest.trim()),
        None => (trimmed, ""),
    }
}

/// The longest start of `text` within `max` UTF-16 units (what zod's `.max()` counts) that
/// ends on a character boundary.
pub fn cut_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max {
            return &text[..at];
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::{cut_utf16, split};

    #[test]
    fn a_cut_counts_utf16_units_and_never_splits_a_character() {
        assert_eq!(cut_utf16("abc", 3), "abc");
        assert_eq!(cut_utf16("abc", 2), "ab");
        // An emoji is two units: one unit of room is no room for it.
        assert_eq!(cut_utf16("a\u{1F600}b", 2), "a");
        assert_eq!(cut_utf16("a\u{1F600}b", 3), "a\u{1F600}");
    }

    #[test]
    fn the_first_line_is_the_title_and_the_rest_the_body() {
        assert_eq!(split("  Milk  "), ("Milk", ""));
        assert_eq!(split("\n\nMilk\r\n\n oat, 2 l \n"), ("Milk", "oat, 2 l"));
        assert_eq!(
            split("Milk\nline one\n\nline two"),
            ("Milk", "line one\n\nline two")
        );
    }
}

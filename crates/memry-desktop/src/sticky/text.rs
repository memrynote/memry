//! `stickies/text.ts`: how sticky text splits into a title and a body.

/// The first line of the trimmed text is the title; whatever follows it, trimmed, is the body.
pub fn split(text: &str) -> (&str, &str) {
    let trimmed = text.trim();
    match trimmed.split_once('\n') {
        Some((first, rest)) => (first.trim(), rest.trim()),
        None => (trimmed, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::split;

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

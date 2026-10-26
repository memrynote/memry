//! The frontmatter split never loses a byte: `block + body == raw` for any
//! input (protocol 12.4.1), and parsing then serializing an unedited note gives
//! the input back.

#![no_main]

use libfuzzer_sys::fuzz_target;
use memry_core::markdown::frontmatter::{
    parse_markdown_note, serialize_parsed_markdown_note, split_frontmatter_block,
};

fuzz_target!(|raw: &str| {
    let split = split_frontmatter_block(raw);
    let mut joined = String::with_capacity(raw.len());
    joined.push_str(split.block.unwrap_or(""));
    joined.push_str(split.body);
    assert_eq!(joined, raw, "block + body is not the input");

    if let Ok(parsed) = parse_markdown_note(raw) {
        let content = parsed.content.clone();
        let again = serialize_parsed_markdown_note(&parsed, &content, false);
        assert_eq!(again, raw, "an unedited note did not round-trip");
    }
});

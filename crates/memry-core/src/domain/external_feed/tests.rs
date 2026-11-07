//! Unit tests of the feed's helpers.

use super::*;

#[test]
fn a_version_block_says_the_writing_data_of_its_body_and_keeps_its_byte_order_mark() {
    let block =
        "\u{feff}---\ntitle: t\nwriting: {alternatives: {k3x9q2: {versions: [two]}}}\n---\n";
    let rewritten = with_writing(Some(block), &WritingFrontmatter::default()).unwrap();
    assert_eq!(rewritten, "\u{feff}---\ntitle: t\n---\n");
    assert_eq!(
        with_writing(Some("---\ntitle: t\n---\n"), &WritingFrontmatter::default()).as_deref(),
        Some("---\ntitle: t\n---\n")
    );
    assert_eq!(with_writing(None, &WritingFrontmatter::default()), None);
}

#[test]
fn the_cap_is_on_the_packed_length_not_the_raw_one() {
    // Repetitive: 6 MiB raw packs far below the cap. Incompressible: 5 MiB raw packs above it.
    assert!(rides_as_one_update(&vec![b'a'; 6 * 1024 * 1024]));
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let noise: Vec<u8> = (0..MAX_UPDATE_BYTES)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state.to_le_bytes()[0]
        })
        .collect();
    assert!(!rides_as_one_update(&noise));
}

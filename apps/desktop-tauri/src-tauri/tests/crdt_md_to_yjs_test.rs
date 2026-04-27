use memry_desktop_tauri_lib::crdt::md_to_yjs::md_to_blocknote_blocks;

#[test]
fn parses_paragraph() {
    let blocks = md_to_blocknote_blocks("hello world");

    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, "paragraph");
    assert_eq!(blocks[0].text, "hello world");
}

#[test]
fn parses_heading() {
    let blocks = md_to_blocknote_blocks("# Title\n\nbody");

    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].kind, "heading");
    assert_eq!(blocks[0].level, Some(1));
    assert_eq!(blocks[1].kind, "paragraph");
    assert_eq!(blocks[1].text, "body");
}

#[test]
fn parses_bulleted_list() {
    let blocks = md_to_blocknote_blocks("- one\n- two");

    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].kind, "bulletListItem");
    assert_eq!(blocks[0].text, "one");
    assert_eq!(blocks[1].kind, "bulletListItem");
    assert_eq!(blocks[1].text, "two");
}

#[test]
fn parses_numbered_list() {
    let blocks = md_to_blocknote_blocks("1. one\n2. two");

    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].kind, "numberedListItem");
    assert_eq!(blocks[1].kind, "numberedListItem");
}

#[test]
fn parses_code_block() {
    let blocks = md_to_blocknote_blocks("```rust\nlet x = 1;\n```");

    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, "codeBlock");
    assert_eq!(blocks[0].language.as_deref(), Some("rust"));
    assert!(blocks[0].text.contains("let x = 1"));
}

#[test]
fn empty_input_yields_empty_paragraph() {
    let blocks = md_to_blocknote_blocks("");

    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, "paragraph");
    assert_eq!(blocks[0].text, "");
}

#[test]
fn turkish_diacritics_round_trip() {
    let blocks = md_to_blocknote_blocks("Türkçe başlık şıkğüöç");

    assert_eq!(blocks[0].text, "Türkçe başlık şıkğüöç");
}

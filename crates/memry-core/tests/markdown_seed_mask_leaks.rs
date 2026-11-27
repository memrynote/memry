//! A mask's placeholder never reaches the seeded document.
//!
//! The seed hides constructs behind per-process placeholders while it reads,
//! as desktop's parse does (`apps/desktop/src/main/sync/mask-leaks.test.ts`
//! holds the same grid), and swaps them back once the blocks exist. Each
//! trigger sits in each place a block carries a string (a link address, an
//! image's alt and address, a code fence's language, a math block), and the
//! plan must hold the author's bytes, never a placeholder. No input holds
//! `MEMRY`, so any in the plan is a leak.

use memry_core::crdt::markdown_seed::{SeedInline, SeedKind, plan};

const TRIGGERS: [(&str, &str); 13] = [
    ("a hard break", "x  \ny"),
    ("a backslash break", "x\\\ny"),
    ("a mention token", "((mention:a_b_c))"),
    ("a date token", "((date:2020-01-01))"),
    ("a spaced address", "[a](u \"t\")"),
    ("an angled address", "[a](<u v>)"),
    ("an address across a hard break", "[a](u  \nv)"),
    ("a comment", "%% c %%"),
    ("an html comment", "<!-- c -->"),
    ("a comment across lines", "%% c\nd %%"),
    ("an empty-label link", "[](u)"),
    ("an empty-label link across lines", "[](u\nv)"),
    ("a details tag", "<details>"),
];

const PLACES: [(&str, &str); 19] = [
    ("a link address", "[a](u{T})"),
    ("an angled link address", "[a](<u{T}>)"),
    ("a link title", "[a](u \"{T}\")"),
    ("an image alt", "![a{T}](u)"),
    ("an image address", "![a](u{T})"),
    ("an image title", "![a](u \"{T}\")"),
    ("a code fence language", "```js{T}\nx\n```"),
    ("a tilde fence language", "~~~{T}\nx\n~~~"),
    (
        "a fence language in a list item",
        "- a\n    ```{T}\n    x\n    ```",
    ),
    ("a table cell", "| a | b |\n| - | - |\n| {T} | c |"),
    ("a table cell link address", "| a |\n| - |\n| [a](u{T}) |"),
    ("a table cell image alt", "| a |\n| - |\n| ![x{T}](u) |"),
    ("a heading", "# {T}"),
    ("a quote", "> {T}"),
    ("a list item", "- {T}"),
    ("a callout title", "> [!note] {T}\n> x"),
    (
        "a toggle summary",
        "<details>\n<summary>{T}</summary>\n\nx\n\n</details>",
    ),
    ("a math block", "$$\n{T}\n$$"),
    ("link text", "[{T}](u)"),
];

#[test]
fn no_trigger_in_any_place_leaves_a_placeholder_in_the_plan() {
    let mut leaks = Vec::new();
    for (place, template) in PLACES {
        for (trigger, text) in TRIGGERS {
            let markdown = template.replace("{T}", text);
            let seeded = plan(&markdown);
            let held = format!("{:?}", seeded.blocks);
            if held.contains("MEMRY") {
                leaks.push(format!("{trigger} in {place}: {markdown:?}"));
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "placeholders in the plan:\n{}",
        leaks.join("\n")
    );
}

fn language_of(markdown: &str) -> String {
    let seeded = plan(markdown);
    let mut found = None;
    let mut stack: Vec<_> = seeded.blocks.iter().collect();
    while let Some(block) = stack.pop() {
        if let SeedKind::CodeBlock { language } = &block.kind {
            found = Some(language.clone());
        }
        stack.extend(block.children.iter());
    }
    found.unwrap_or_else(|| panic!("no code block in {markdown:?}: {:?}", seeded.blocks))
}

#[test]
fn a_comment_in_a_fence_info_string_is_the_language_as_written() {
    assert_eq!(language_of("```%% c %%`\nx\n```"), "%% c %%`");
    assert_eq!(language_of("```js %% c %%``"), "js %% c %%``");
    assert_eq!(
        language_of("- a\n    ```%% c %%\n    x\n    ```"),
        "%% c %%"
    );
    assert_eq!(
        language_of("- a\n    ```js %% c %%\n    x\n    ```"),
        "js %% c %%"
    );
}

#[test]
fn an_address_across_a_hard_break_is_the_address_before_it() {
    let seeded = plan("[a](u  \nv)");
    let SeedInline::Text { marks, .. } = &seeded.blocks[0].content[0] else {
        panic!("a link run: {:?}", seeded.blocks);
    };
    assert_eq!(marks.link.as_deref(), Some("u"));
}

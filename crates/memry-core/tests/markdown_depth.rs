//! No input of any shape can abort the process: a stack overflow is not a
//! panic, `catch_unwind` cannot stop it, and the vault watcher would feed the
//! same file to the converter again after every restart. Each case runs on a
//! 2 MiB thread (the default for a spawned Rust thread, smaller than the main
//! thread's) in a debug build, the worst case for frame size.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::convert::NoEmbeds;
use support::doc_case::{converter_for, open_document};

fn on_small_stack(work: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(work)
        .expect("spawn")
        .join()
        .expect("the conversion must not overflow the stack");
}

fn seeds(markdown: String) -> bool {
    let converter = converter_for(&serde_json::json!({}));
    let doc = open_document();
    converter.seed_body(&doc, &markdown, None, None, &NoEmbeds)
}

#[test]
fn deep_quotes_fail_closed() {
    for depth in [90usize, 1_000, 5_000, 50_000] {
        on_small_stack(move || {
            let ok = seeds(format!("{} x", ">".repeat(depth)));
            assert_eq!(ok, depth <= 100, "depth {depth}");
        });
    }
}

#[test]
fn deep_spaced_quotes_and_lists_fail_closed() {
    on_small_stack(|| assert!(!seeds("> ".repeat(20_000))));
    // Indentation alone is not nesting: the TypeScript accepts it, so must the Rust.
    on_small_stack(|| assert!(seeds(format!("{}- x", " ".repeat(4_000)))));
    on_small_stack(|| {
        let nested: String = (0..3_000)
            .map(|i| format!("{}- x\n", "  ".repeat(i)))
            .collect();
        assert!(!seeds(nested));
    });
}

#[test]
fn deep_html_fails_closed() {
    for depth in [90usize, 1_000, 20_000] {
        on_small_stack(move || {
            let ok = seeds(format!(
                "{}x{}",
                "<div>".repeat(depth),
                "</div>".repeat(depth)
            ));
            assert_eq!(ok, depth <= 90, "depth {depth}");
        });
    }
    on_small_stack(|| assert!(!seeds("<blockquote>".repeat(30_000))));
    on_small_stack(|| assert!(!seeds("<ul><li>".repeat(30_000))));
}

#[test]
fn a_deep_yjs_tree_is_refused_not_walked() {
    use yrs::{WriteTxn, XmlElementPrelim, XmlFragment};
    on_small_stack(|| {
        let converter = converter_for(&serde_json::json!({}));
        let doc = open_document();
        doc.write(|txn| {
            let fragment = txn.get_or_insert_xml_fragment("prosemirror");
            let mut parent = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            for _ in 0..5_000 {
                parent = parent.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            }
        })
        .expect("write");
        let options = memry_core::markdown::convert::restore::SerializeOptions::default();
        assert!(
            converter
                .doc_to_markdown(&doc, "prosemirror", &options)
                .is_none()
        );
        assert!(converter.blocks(&doc, "prosemirror").is_none());
        assert!(
            !converter
                .find_unrepresentable_nodes(&doc, "prosemirror")
                .is_empty()
        );
        assert_eq!(converter.repair_empty_block_ids(&doc, "prosemirror"), 0);
    });
}

/// `<td colspan="100000000">` once allocated about 20 GB. The oracle answers a
/// 100000-column span and fails on a million (`table-span-*` cases), and the
/// Rust must neither allocate gigabytes nor differ from that.
#[test]
fn a_huge_table_span_fails_closed_without_allocating_it() {
    for (attr, n, ok) in [
        ("colspan", 2u64, true),
        ("colspan", 100_000, true),
        ("colspan", 1_000_000, false),
        ("colspan", 100_000_000, false),
        ("rowspan", 100_000_000, false),
        ("colspan", 99_999_999_999_999_999, false),
    ] {
        let md = format!(
            "<table><tr><td {attr}=\"{n}\">x</td><td>y</td></tr><tr><td>a</td><td>b</td></tr></table>"
        );
        assert_eq!(seeds(md), ok, "{attr}={n}");
    }
}

/// Inline nesting: the recursion is in the markdown parser itself, so a
/// 20 KB note of brackets overflowed a 2 MiB stack at n=10000 (release) and
/// n=1000 (debug). The TypeScript fails at about 3000.
#[test]
fn deep_inline_nesting_fails_closed() {
    for n in [100usize, 1_000, 10_000] {
        on_small_stack(move || {
            let nested = format!("{}x{}", "[".repeat(n), "](u)".repeat(n));
            assert_eq!(seeds(nested), n <= 100, "nested links, n={n}");
        });
        on_small_stack(move || {
            assert!(!seeds(format!(
                "{}{}",
                "[a ".repeat(n.max(300)),
                "](u)".repeat(n.max(300))
            )));
        });
        on_small_stack(move || {
            // Emphasis inside emphasis inside links: every recursive path.
            let nested = format!("{}x{}", "[*".repeat(n), "*](u)".repeat(n));
            assert_eq!(seeds(nested), n <= 100, "links and emphasis, n={n}");
        });
    }
    on_small_stack(|| {
        assert!(!seeds(format!(
            "{}x{}",
            "**[".repeat(5_000),
            "](u)**".repeat(5_000)
        )))
    });
    on_small_stack(|| {
        // An image's alt text is not parsed again, so this is flat.
        assert!(seeds(format!(
            "{}x{}",
            "![".repeat(20_000),
            "](u)".repeat(20_000)
        )))
    });
}

/// What the TypeScript accepts must still convert: a fence of `>` characters,
/// code indented far past any list, and the real list depth.
#[test]
fn deep_looking_but_flat_input_still_converts() {
    on_small_stack(|| {
        assert!(seeds(format!("```\n{}\n```\n", ">".repeat(500))));
        assert!(seeds(format!("{}text\n", " ".repeat(500))));
        let list: String = (0..40)
            .map(|i| format!("{}- x\n", "  ".repeat(i)))
            .collect();
        assert!(seeds(list));
        assert!(seeds(format!("{}- x\n", " ".repeat(300))));
    });
}

/// The remaining recursive shapes of the markdown layers: toggles, columns,
/// unclosed emphasis, and tasks. None may abort a 2 MiB stack.
#[test]
fn other_recursive_shapes_do_not_abort() {
    let columns = "<!-- memry:columns -->\n<div data-column-list>\n<div data-column>\n\n";
    for (label, markdown) in [
        (
            "toggles",
            "<details>\n<summary>t</summary>\n\n".repeat(2_000),
        ),
        ("columns", columns.repeat(2_000)),
        ("emphasis", "**a *b ".repeat(4_000)),
        ("strike", "~~a **b _c ".repeat(2_000)),
        (
            "tasks",
            (0..2_000)
                .map(|i| format!("{}- [ ] t\n", "  ".repeat(i % 60)))
                .collect(),
        ),
        (
            "callouts",
            "> [!note]\n".repeat(2_000) + &"> ".repeat(2_000),
        ),
        ("tables", "| a | ".repeat(5_000) + "|\n| - |\n"),
        ("comments", "<!-- ".repeat(5_000)),
    ] {
        on_small_stack(move || {
            let _ = seeds(markdown);
            eprintln!("{label}: survived");
        });
    }
}

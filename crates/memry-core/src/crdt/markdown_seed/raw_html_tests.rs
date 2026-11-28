//! Tests of [`super`]: the hidden ranges, the mask and its restore.

use super::super::html_tag::BOUND;
use super::super::nesting::MAX_NESTING;
use super::*;

/// The source of each range the scan hides in `markdown`.
fn hidden(markdown: &str) -> Vec<String> {
    let chars: Vec<char> = markdown.chars().collect();
    scan(markdown, true)
        .into_iter()
        .map(|span| chars[span.start..span.end].iter().collect())
        .collect()
}

#[test]
fn each_whole_tag_the_editor_does_not_handle_is_hidden() {
    for (markdown, expected) in [
        ("<kbd>Ctrl</kbd>", vec!["<kbd>", "</kbd>"]),
        ("<KBD>", vec!["<KBD>"]),
        (
            "<kq a=\"1 2\" b='3' c=4 d>",
            vec!["<kq a=\"1 2\" b='3' c=4 d>"],
        ),
        ("<kq/> <kq />", vec!["<kq/>", "<kq />"]),
        (
            "<!x> <?x?> <![CDATA[x]]>",
            vec!["<!x>", "<?x?>", "<![CDATA[x]]>"],
        ),
        ("<script>kq9</script>", vec!["<script>", "</script>"]),
        ("<input type=text>", vec!["<input type=text>"]),
        ("<x a=\"*b*\">", vec!["<x a=\"*b*\">"]),
        ("\\<kq>", vec!["<kq>"]),
        ("<x a=\"<kbd>\">", vec!["<x a=\"<kbd>\">"]),
    ] {
        assert_eq!(hidden(markdown), expected, "{markdown:?}");
    }
}

#[test]
fn a_tag_the_editor_handles_is_left_alone() {
    for tag in [
        "<b>",
        "</STRONG>",
        "<a href=\"u\">",
        "<br/>",
        "<img src=x>",
        "<span style=\"color:red\">x</span>",
        "<span STYLE>y</span>",
        "<details open data-memry-toggle>",
        "<input checked type=\"checkbox\">",
        "<input type=CHECKBOX>",
    ] {
        assert_eq!(hidden(&format!("a {tag} b")), Vec::<String>::new(), "{tag}");
    }
}

#[test]
fn a_handled_tag_past_the_nesting_cap_is_hidden_with_its_closing_tag() {
    let cap = MAX_NESTING;
    let text = format!("{}x{}", "<b>".repeat(cap + 1), "</b>".repeat(cap + 1));
    let chars: Vec<char> = text.chars().collect();
    let spans = scan(&text, true);
    // The first closing tag closes the innermost open tag, the one the cap hid.
    assert_eq!(
        spans,
        [
            Span::hidden(cap * 3, cap * 3 + 3),
            Span::hidden((cap + 1) * 3 + 1, (cap + 1) * 3 + 5)
        ]
    );
    assert_eq!(
        chars[spans[0].start..spans[0].end]
            .iter()
            .collect::<String>(),
        "<b>"
    );

    assert_eq!(
        hidden(&format!("{}x{}", "<b>".repeat(cap), "</b>".repeat(cap))),
        Vec::<String>::new()
    );
    assert_eq!(hidden(&"<b>x</b>".repeat(50 * cap)), Vec::<String>::new());
    assert_eq!(
        hidden(&"<b><i><u><s><code>\n".repeat(21)),
        ["<b>", "<i>", "<u>", "<s>", "<code>"]
    );
    let styled = format!(
        "{}x{}",
        "<span style=\"c\">".repeat(cap + 1),
        "</span>".repeat(cap + 1)
    );
    assert_eq!(hidden(&styled), ["<span style=\"c\">", "</span>"]);
    assert_eq!(hidden(&"<b\n".repeat(cap + 1)), ["<"]);
    assert_eq!(hidden(&format!("{}<b\n", "<b ".repeat(cap))), ["<"]);
    assert_eq!(hidden(&"<b/>".repeat(cap + 1)), ["<b/>"]);
    let empty = "<br><img src=a><hr><input type=checkbox><br/>".repeat(5 * cap);
    assert_eq!(hidden(&empty), Vec::<String>::new());
    assert_eq!(
        hidden(&format!("{}<b>", "</b>".repeat(5 * cap))),
        Vec::<String>::new()
    );
}

/// `html-nesting.test.ts`, 'marks a list item or a table cell ends'.
#[test]
fn a_list_item_and_a_table_cell_end_the_marks_opened_in_them() {
    let lines = |count: usize, make: &dyn Fn(usize) -> String| -> String {
        (0..count).map(make).collect::<Vec<_>>().join("\n")
    };
    let table = |rows: String| format!("| a | b |\n| - | - |\n{rows}");
    let cap = MAX_NESTING;
    for markdown in [
        lines(cap + 5, &|i| format!("- <i>item{i}")),
        lines(cap + 5, &|i| format!("{}. <i>item{i}", i + 1)),
        lines(cap + 5, &|i| format!("> - <i>item{i}")),
        format!("- a\n{}", lines(cap + 5, &|i| format!("  - <i>item{i}"))),
        table(lines(cap + 5, &|i| format!("| <b>c{i} | x |"))),
        format!(
            "{} |\n{} |",
            "| <b>c".repeat(cap + 6),
            "| -".repeat(cap + 6)
        ),
    ] {
        assert_eq!(hidden(&markdown), Vec::<String>::new());
    }
    assert_eq!(
        hidden(&lines(cap + 5, &|i| format!("- <b data-n=\"{i}\">x"))).len(),
        5
    );
    assert_eq!(
        hidden(&table(lines(cap + 5, &|i| format!(
            "| <b data-n=\"{i}\">x |"
        ))))
        .len(),
        5
    );
    for markdown in [
        lines(cap + 5, &|_| "a | <b>x".to_owned()),
        "| <b>x ".repeat(cap + 5),
        format!("a\n{}", lines(cap + 5, &|i| format!("{}. <b>x", i + 2))),
        format!("a\n{}", lines(cap + 5, &|_| "    - <b>x".to_owned())),
    ] {
        assert_eq!(hidden(&markdown).len(), 5);
    }
}

#[test]
fn a_closing_span_belongs_to_the_innermost_open_span() {
    assert_eq!(hidden("<span>a</span>"), ["<span>", "</span>"]);
    assert_eq!(
        hidden("<span style=\"c\"><span>a</span></span>"),
        ["<span>", "</span>"]
    );
    assert_eq!(
        hidden("</span> <span style=\"c\">a</span> </span>"),
        ["</span>", "</span>"]
    );
    assert_eq!(hidden("<span/> </span>"), ["<span/>", "</span>"]);
    assert_eq!(hidden("<span>\nb\n</span>"), ["<span>", "</span>"]);
}

#[test]
fn only_the_angle_bracket_of_a_tag_read_not_whole_is_hidden() {
    for markdown in [
        "<kq\nb>",
        "a <div",
        "a <?x",
        "a <![CDATA[x",
        "<kq a=>",
        "<kq a=\"x>",
        "<kq a=\"1\"b=\"2\">",
        "<!1>",
        "<span\nstyle=\"c\">",
        "<x a=\"|\">",
    ] {
        assert_eq!(hidden(markdown), ["<"], "{markdown:?}");
    }
    assert_eq!(hidden("<https://e.com> <a@b.co>"), ["<", "<"]);
    assert_eq!(hidden("| <x a=\"b\"> | <y> |"), ["<x a=\"b\">", "<y>"]);
}

#[test]
fn a_lt_that_opens_no_construct_is_left_alone() {
    for markdown in [
        "< kq>",
        "<1>",
        "<>",
        "</>",
        "</ kq>",
        "<!-- c -->",
        "<!--",
        "a < b",
        "a<",
        "<<",
        "1 <= 2",
        "<-",
    ] {
        assert_eq!(hidden(markdown), Vec::<String>::new(), "{markdown:?}");
    }
}

#[test]
fn a_lt_in_code_or_opening_a_link_address_is_not_a_tag() {
    for (markdown, expected) in [
        ("```\n<kbd>\n```", vec![]),
        ("~~~js\n<kbd>\n~~~\n<kbd>", vec!["<kbd>"]),
        ("`<kbd>` `` <x> `` <kbd>", vec!["<kbd>"]),
        ("[a](<x>) [b](  <y z>) ![c](<w>)", vec![]),
        ("[a](u<x>)", vec!["<x>"]),
        ("x](<kbd>)", vec!["<kbd>"]),
        ("\\[a\\](<kbd>)", vec!["<kbd>"]),
        ("[a [b](<x>) c](<y>)", vec![]),
        ("a ` <kbd>", vec!["<kbd>"]),
        ("a \\`<kbd>\\` b", vec!["<kbd>"]),
        ("<x a=\"`\"> `b`", vec!["<x a=\"`\">"]),
    ] {
        assert_eq!(hidden(markdown), expected, "{markdown:?}");
    }
}

#[test]
fn a_tag_is_read_whole_only_within_the_bound_in_utf16_units() {
    let tag = |fill: usize| format!("<x a=\"{}\">", "y".repeat(fill));
    assert_eq!(hidden(&tag(BOUND - 9)), [tag(BOUND - 9)]);
    assert_eq!(hidden(&tag(BOUND - 8)), [tag(BOUND - 8)]);
    assert_eq!(hidden(&tag(BOUND - 7)), ["<"]);
    let emoji = |count: usize| format!("<x a=\"{}\">", "😀".repeat(count));
    assert_eq!(hidden(&emoji((BOUND - 8) / 2)), [emoji((BOUND - 8) / 2)]);
    assert_eq!(hidden(&emoji((BOUND - 8) / 2 + 1)), ["<"]);
}

#[test]
fn a_long_line_of_unfinished_constructs_is_read_in_linear_time() {
    for markdown in [
        "<a ".repeat(200_000),
        "<x a=\"".repeat(100_000),
        "<?".repeat(200_000),
        "<![CDATA[".repeat(100_000),
        "`<x ".repeat(100_000),
    ] {
        let started = std::time::Instant::now();
        scan(&markdown, true);
        assert!(started.elapsed().as_secs() < 2);
    }
}

#[test]
fn a_hidden_tag_comes_back_and_a_stray_token_stays() {
    let markdown = "a <kbd>Ctrl</kbd> and <x a=\"*b*\"> or <div and <script>kq9</script>";
    let (masked, sources) = mask(markdown);
    assert!(!masked.contains('<'));
    assert_eq!(sources.len(), 6);
    assert_eq!(restore(&masked, &sources), markdown);
    let stray = format!("{}99;", token_prefix());
    assert_eq!(restore(&stray, &sources), stray);
    assert_eq!(mask("plain <b>text</b>").1, Vec::<String>::new());
}

#[test]
fn a_tag_in_code_does_not_send_its_line_to_the_fallback() {
    assert_eq!(fallback("kq0 `<kbd>` kq1"), None);
    assert_eq!(fallback("a \\<kq> `b`"), Some("HTML"));
    assert_eq!(fallback("a <b>x</b>"), Some("HTML"));
    assert_eq!(fallback("a <!-- c"), Some("HTML"));
}

#[test]
fn a_tag_that_holds_a_comment_is_left_for_the_fallback() {
    for markdown in [
        "<kq a=\"<!-- c -->\">",
        "<?x <!-- c -->?>",
        "<![CDATA[ <!-- c --> ]]>",
        "<!x <!-- c --> >",
    ] {
        assert_eq!(hidden(markdown), Vec::<String>::new(), "{markdown:?}");
    }
    assert_eq!(hidden("<kq a=\"%% c %%\">"), ["<kq a=\"%% c %%\">"]);
}

#[test]
fn a_backslash_before_a_handled_tag_hides_the_tag_as_escaped() {
    let escaped = |markdown: &str| -> Vec<(String, bool)> {
        let chars: Vec<char> = markdown.chars().collect();
        scan(markdown, true)
            .into_iter()
            .map(|span| (chars[span.start..span.end].iter().collect(), span.escaped))
            .collect()
    };
    let case = |markdown: &str, expected: &[(&str, bool)]| {
        let expected: Vec<(String, bool)> = expected
            .iter()
            .map(|(tag, escaped)| ((*tag).to_owned(), *escaped))
            .collect();
        assert_eq!(escaped(markdown), expected, "{markdown:?}");
    };
    case("\\<b>x\\</b>", &[("<b>", true), ("</b>", true)]);
    case("\\<a href=\"u\">", &[("<a href=\"u\">", true)]);
    case("\\<br/>", &[("<br/>", true)]);
    case("\\<details data-memry-toggle>", &[]);
    case(
        "\\<input type=checkbox>",
        &[("<input type=checkbox>", true)],
    );
    case("\\\\<b>", &[]);
    case("\\\\\\<b>", &[("<b>", true)]);
    case(
        "\\<span style=\"color:red\">x\\</span>",
        &[("<span style=\"color:red\">", true), ("</span>", true)],
    );
    case("\\<span>", &[("<span>", true)]);
    case("\\<kq>", &[("<kq>", false)]);
    case("\\</details>", &[("</details>", false)]);
    case("\\<input type=text>", &[("<input type=text>", false)]);
    case("\\<b x", &[]);
    case("\\<kq x", &[("<", false)]);
    case("\\<b a=\"|\">", &[("<", true)]);
    case("`\\<b>`", &[]);
    case("```\n\\<b>\n```", &[]);
    let many = "\\<b>".repeat(5 * MAX_NESTING);
    assert_eq!(scan(&many, true).len(), 5 * MAX_NESTING);
    assert_eq!(hidden(&format!("{many}<b>x</b>")).len(), 5 * MAX_NESTING);
}

#[test]
fn an_escaped_tag_loses_its_backslash_to_the_mask_and_comes_back_as_text() {
    let (masked, sources) = mask("a \\<b>x\\</b> \\\\ \\<kq>");
    assert_eq!(sources, ["<b>", "</b>", "<kq>"]);
    let prefix = token_prefix();
    assert_eq!(masked, format!("a {prefix}0;x{prefix}1; \\\\ \\{prefix}2;"));
    assert_eq!(restore(&masked, &sources), "a <b>x</b> \\\\ \\<kq>");
}

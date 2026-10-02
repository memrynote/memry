//
//  MarkdownShortcutsTests.swift
//  Desktop's markdown input rules and the `/` menu, as pure functions.
//

import Foundation
import Testing

@testable import Memry

@Suite("Markdown shortcuts")
struct MarkdownShortcutsTests {

    @Test func hashes_and_a_space_make_a_heading_of_that_level() {
        #expect(MarkdownShortcut.block("# ", in: "paragraph") == .init(kind: "heading", level: 1, prefixLength: 2))
        #expect(MarkdownShortcut.block("### ", in: "paragraph")?.level == 3)
        #expect(MarkdownShortcut.block("###### ", in: "paragraph")?.level == 6)
        #expect(MarkdownShortcut.block("####### ", in: "paragraph") == nil)
        #expect(MarkdownShortcut.block("#", in: "paragraph") == nil, "the space is the trigger")
        #expect(MarkdownShortcut.block("a # ", in: "paragraph") == nil, "only at the start of the block")
    }

    @Test func list_markers_make_lists() {
        #expect(MarkdownShortcut.block("- ", in: "paragraph")?.kind == "bulletListItem")
        #expect(MarkdownShortcut.block("* ", in: "paragraph")?.kind == "bulletListItem")
        #expect(MarkdownShortcut.block("+ ", in: "paragraph")?.kind == "bulletListItem")
        #expect(MarkdownShortcut.block("1. ", in: "paragraph") == .init(kind: "numberedListItem", prefixLength: 3))
        #expect(MarkdownShortcut.block("4. ", in: "paragraph")?.props == ["start": "4"])
        #expect(MarkdownShortcut.block("1. ", in: "heading") == nil, "desktop skips the numbered rule in a heading")
        #expect(MarkdownShortcut.block("- ", in: "heading") == nil, "BlockNote's bullet rule refuses a heading")
        #expect(MarkdownShortcut.block("* ", in: "heading") == nil)
        #expect(MarkdownShortcut.block("+ ", in: "heading") == nil)
    }

    @Test func brackets_make_a_check_item() {
        #expect(MarkdownShortcut.block("[] ", in: "paragraph")?.props == ["checked": "false"])
        #expect(MarkdownShortcut.block("[ ] ", in: "paragraph")?.kind == "checkListItem")
        #expect(MarkdownShortcut.block("[x] ", in: "paragraph")?.props == ["checked": "true"])
        #expect(MarkdownShortcut.block("[X] ", in: "paragraph")?.props == ["checked": "true"])
    }

    @Test func quote_code_and_divider() {
        #expect(MarkdownShortcut.block("> ", in: "paragraph")?.kind == "quote")
        #expect(MarkdownShortcut.block("\u{201C} ", in: "paragraph")?.kind == "quote", "a smart quote is a quotation mark")
        #expect(MarkdownShortcut.block("``` ", in: "paragraph") == .init(kind: "codeBlock", prefixLength: 4))
        #expect(MarkdownShortcut.block("```Swift ", in: "paragraph")?.props == ["language": "swift"])
        #expect(MarkdownShortcut.block("```js ", in: "paragraph")?.props == ["language": "javascript"])
        #expect(MarkdownShortcut.block("```PY ", in: "paragraph")?.props == ["language": "python"])
        #expect(MarkdownShortcut.block("```c# ", in: "paragraph")?.props == ["language": "csharp"])
        #expect(MarkdownShortcut.block("```pwsh ", in: "paragraph")?.props == ["language": "powershell"])
        #expect(MarkdownShortcut.block("```Brainfuck ", in: "paragraph")?.props == ["language": "Brainfuck"], "an unknown name is kept as typed")
        #expect(MarkdownShortcut.block("---", in: "paragraph")?.kind == "divider")
        #expect(MarkdownShortcut.block("\u{2014}-", in: "paragraph")?.kind == "divider", "smart dashes turn -- into an em dash")
    }

    @Test func no_rule_runs_in_a_code_block() {
        #expect(MarkdownShortcut.block("# ", in: "codeBlock") == nil)
        #expect(MarkdownShortcut.mark("**a**", in: "codeBlock") == nil)
    }

    @Test func delimiters_make_marks_over_their_content() {
        let bold = MarkdownShortcut.mark("say **hi**", in: "paragraph")
        #expect(bold == .init(mark: "bold", match: NSRange(location: 4, length: 6), content: NSRange(location: 6, length: 2)))
        #expect(MarkdownShortcut.mark("__hi__", in: "paragraph")?.mark == "bold")
        #expect(MarkdownShortcut.mark("*hi*", in: "paragraph")?.mark == "italic")
        #expect(MarkdownShortcut.mark("a _hi_", in: "paragraph")?.content == NSRange(location: 3, length: 2))
        #expect(MarkdownShortcut.mark("~~hi~~", in: "paragraph")?.mark == "strike")
        #expect(MarkdownShortcut.mark("**hi*", in: "paragraph") == nil, "the bold is not closed yet")
        #expect(MarkdownShortcut.mark("a*b*", in: "paragraph") == nil, "italic needs a space or the start before it")
    }

    @Test func backticks_make_code_and_keep_the_char_before() {
        let code = MarkdownShortcut.mark("x`hi`", in: "paragraph")
        #expect(code == .init(mark: "code", match: NSRange(location: 1, length: 4), content: NSRange(location: 2, length: 2)))
        let spaced = MarkdownShortcut.mark("`hi` ", in: "paragraph")
        #expect(spaced?.trailing == " ")
        #expect(spaced?.match == NSRange(location: 0, length: 5))
        #expect(MarkdownShortcut.mark("``hi`", in: "paragraph") == nil)
    }

    @MainActor
    @Test func no_rule_runs_next_to_inline_code() {
        let text = NSMutableAttributedString(string: "a ", attributes: [.memryMarks: [String]()])
        text.append(NSAttributedString(string: "code", attributes: [.memryMarks: ["code"]]))
        text.append(NSAttributedString(string: " b", attributes: [.memryMarks: [String]()]))
        #expect(MarkdownShortcut.touchesCode(text, at: 4), "inside the code run")
        #expect(MarkdownShortcut.touchesCode(text, at: 6), "right after it")
        #expect(MarkdownShortcut.touchesCode(text, at: 2), "right before it")
        #expect(!MarkdownShortcut.touchesCode(text, at: 1))
        #expect(!MarkdownShortcut.touchesCode(text, at: 8))
    }
}

@Suite("Slash menu")
@MainActor
struct SlashMenuTests {

    @Test func a_slash_at_the_start_or_after_a_space_opens_the_menu() {
        #expect(InlineTrigger.active(in: "/", caret: 1) == .slash(range: NSRange(location: 0, length: 1), query: ""))
        #expect(InlineTrigger.active(in: "hi /he", caret: 6) == .slash(range: NSRange(location: 3, length: 3), query: "he"))
        #expect(InlineTrigger.active(in: "and/or", caret: 6) == nil)
        #expect(InlineTrigger.active(in: "http://x", caret: 8) == nil)
        #expect(InlineTrigger.active(in: "1 / 2", caret: 5) == nil, "a query cannot start with a space")
    }

    @Test func the_nearer_trigger_wins() {
        #expect(InlineTrigger.active(in: "@x /he", caret: 6) == .slash(range: NSRange(location: 3, length: 3), query: "he"))
    }

    @Test func a_query_filters_and_lifts_the_best_match() {
        let items = BlockCatalog.rows(attach: false)
        // "list" is in four titles, none at the start: catalog order stands.
        #expect(BlockCatalog.filter(items, query: "list").prefix(4).map(\.id) == ["bullet_list", "numbered_list", "check_list", "toggle_list"])
        // "quote" is a title prefix, ahead of every alias match.
        #expect(BlockCatalog.filter(items, query: "quo").first?.id == "quote")
        // "code" matches "Code Block" by title: lifted over nothing earlier.
        #expect(BlockCatalog.filter(items, query: "code").first?.id == "code_block")
        // "h2" matches only through an alias, which the toggle heading shares.
        #expect(BlockCatalog.filter(items, query: "h2").map(\.id) == ["heading_2", "toggle_heading_2"])
        // "hr": the divider's alias, lifted above earlier weaker matches.
        #expect(BlockCatalog.filter(items, query: "hr").first?.id == "divider")
        #expect(BlockCatalog.filter(items, query: "zzz").isEmpty)
    }
}

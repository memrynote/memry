//
//  ReviewMarkTextTests.swift
//  A review mark's `visibleText` can be the markdown it covers
//  (`start **bold`), as desktop now stores it and as a mark parsed from a
//  file always was, or the words desktop's editor showed (`start bold`), as
//  older builds stored it. Either form is drawn over the words, keeps its
//  block read-only, and is listed as the words.
//

import Foundation
import MemryCore
import SwiftUI
import Testing
import UIKit

@testable import Memry

/// One note: its text and its review marks.
private struct MarkedNote: NotesReading {
    let text: String
    let marks: [ReviewComment]

    func folders() async throws -> [FolderSummary] { [] }

    func list() async throws -> [NoteSummary] { [] }

    func read(id: String) async throws -> NoteDetail? {
        NoteDetail(
            summary: NoteSummary(
                id: id, title: "A note", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
            ),
            body: NoteBody(text: text, present: true)
        )
    }

    func comments(id: String) async throws -> [ReviewComment] { marks }
}

private struct NoEdits: BlockEditing {
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool { true }
}

private func mark(_ visibleText: String, replacing originalText: String? = nil) -> ReviewComment {
    ReviewComment(
        id: visibleText, kind: originalText == nil ? .comment : .substitution, visibleText: visibleText, start: 0,
        end: UInt32(visibleText.utf16.count), originalText: originalText, body: nil, metadata: nil, createdAt: nil
    )
}

/// The stretches of `text` drawn with a review fill, in order.
private func highlighted(_ text: AttributedString) -> [String] {
    var stretches: [String] = []
    var current = ""
    for run in text.runs {
        if run[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] != nil {
            current += String(text[run.range].characters)
        } else if !current.isEmpty {
            stretches.append(current)
            current = ""
        }
    }
    if !current.isEmpty { stretches.append(current) }
    return stretches
}

@MainActor
@Suite("Review marks whose text is markdown")
struct ReviewMarkTextTests {
    @Test(arguments: [
        ("start **bold", "start bold"),
        ("**bold** *it* _em_ __strong__ ***both*** ~~gone~~", "bold it em strong both gone"),
        ("run `npm i` now", "run npm i now"),
        ("see [docs](https://example.com) now", "see docs now"),
        ("[**bold link**](u)", "bold link"),
        ("[[Target|Alias]] and [[Plain]]", "Alias and Plain"),
        ("a \\*literal\\* star", "a *literal* star"),
        // Cut by the mark's edge.
        ("see [do", "see do"),
        ("cs](https://example.com) now", "cs now"),
        ("see [[Target|Al", "see Al"),
        ("see [[Tar", "see Tar"),
        ("get]] now", "get now"),
        ("run `npm", "run npm"),
        // Underline and colour, which desktop writes as HTML.
        ("<span style=\"color:red\"><span style=\"text-decoration:underline\">red</span></span> ink", "red ink"),
        ("<u>under</u> line", "under line"),
        // An image draws as a picture beside the words, as a cell's does.
        ("see ![diagram](d.png) here", "see  here"),
        // Text, as CommonMark reads it.
        ("snake_case, a * b, ~5 min, a < b > c, wow!", "snake_case, a * b, ~5 min, a < b > c, wow!")
    ])
    func markdown_reads_as_the_words_it_shows(markdown: String, shown: String) {
        #expect(ReviewMarkStyle.shownText(markdown) == shown)
    }

    /// `2*3*4` is a plain mark the note shows as written, which reading it as
    /// markdown would turn into `234`. `dup` occurs twice, so its mark is
    /// left to the list in either form.
    @Test func a_markdown_mark_is_drawn_over_its_words_and_a_plain_one_as_before() {
        let note = "start bold text, x = 2*3*4, dup and dup"
        let marks = [mark("start **bold"), mark("2*3*4"), mark("**dup**"), mark("dup")]

        let drawn = ReviewMarkStyle.unambiguous(ReviewMarkStyle.resolved(marks, in: note), in: note)

        #expect(highlighted(ReviewMarkStyle.apply(drawn, to: AttributedString(note))) == ["start bold", "2*3*4"])
    }

    @Test func the_review_list_shows_the_words_not_the_markdown() async {
        let model = NoteReadViewModel(route: NoteRoute(id: "n1"), reader: MarkedNote(
            text: "start bold text\nx = 2*3*4\nnew words",
            marks: [
                mark("start **bold"), mark("2*3*4"), mark("[[Old note|a link]] since deleted"),
                mark("new words", replacing: "**old** words")
            ]
        ))
        await model.loadIfNeeded()

        #expect(model.shownComments.map(\.visibleText) == [
            "start bold", "2*3*4", "a link since deleted", "new words"
        ])
        #expect(model.shownComments.map(\.originalText) == [nil, nil, nil, "old words"])
    }

    /// Editing under a mark moves the words out from under it, so its block
    /// draws read-only. A mark on words the note does not hold leaves the
    /// block editable, which shows the row can be edited here at all.
    @Test(.timeLimit(.minutes(1)), arguments: [
        ("start **bold", false), ("start bold", false), ("not in this note", true)
    ])
    func a_block_under_a_mark_is_read_only(visibleText: String, editable: Bool) async throws {
        let model = NoteReadViewModel(
            route: NoteRoute(id: "n1"), reader: MarkedNote(text: "start bold text", marks: [mark(visibleText)])
        )
        await model.loadIfNeeded()
        let block = Block(id: "b1", kind: "paragraph", depth: 0, props: [], inline: [
            InlineRun(text: "start ", marks: [], markAttrs: [:], target: nil),
            InlineRun(text: "bold", marks: ["bold"], markAttrs: [:], target: nil),
            InlineRun(text: " text", marks: [], markAttrs: [:], target: nil)
        ])
        let editor = NoteEditorViewModel(noteId: "n1", editor: NoEdits())
        let bridge = NoteEditingBridge(model: editor, drawnGeneration: { 0 }, didChange: {})
        let page = NoteBlockView(block: block, editing: bridge)
            .modifier(NotePageEnvironment(model: model, taskBridge: NoteTaskBridge()))

        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        window.rootViewController = UIHostingController(rootView: page)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))

        func textViews(in view: UIView) -> [BlockTextView] {
            ((view as? BlockTextView).map { [$0] } ?? []) + view.subviews.flatMap(textViews)
        }
        #expect(textViews(in: window).isEmpty == !editable)
    }
}

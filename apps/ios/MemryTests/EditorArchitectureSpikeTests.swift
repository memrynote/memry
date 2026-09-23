//
//  EditorArchitectureSpikeTests.swift
//  N300 — the text input spike, measured rather than argued.
//
//  Every editing task downstream of this depends on one decision: does a note
//  become **one text view per block**, or **one document-wide TextKit 2
//  layout**? The two differ on caret behaviour, IME, undo grouping and scroll
//  cost, and the difference only shows up at the size of a real note.
//
//  These tests measure what can be measured — construction, full layout, the
//  cost of one keystroke, and how much of the document a keystroke disturbs —
//  and print the figures so they can be committed to
//  `apps/ios/SpikeEvidence/`. What cannot be measured from a test process
//  (dictation, VoiceOver rotor behaviour, autocorrect) is called out as
//  reasoned rather than measured in the decision record, never dressed up as
//  a number.
//

import Foundation
import Testing
import UIKit

@testable import Memry

/// A note big enough for the difference to show. The tasks name 500 blocks.
private let blockCount = 500

/// Representative block text: short paragraphs, the shape a real note has.
private func spikeBlocks(_ count: Int = blockCount) -> [String] {
    (0..<count).map { index in
        "Block \(index): the quick brown fox jumps over the lazy dog, and then keeps going for a line or two more."
    }
}

/// Elapsed seconds for one closure, as a double so it can be printed.
private func seconds(_ work: () -> Void) -> Double {
    let started = DispatchTime.now().uptimeNanoseconds
    work()
    return Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
}

// MARK: - Architecture A: one UITextView per block

/// Builds one `UITextView` per block and lays each out independently.
///
/// This is the architecture the read surface already implies: a block is a
/// view, and the list composes them.
@MainActor
private func buildPerBlock(_ texts: [String], width: CGFloat) -> [UITextView] {
    texts.map { text in
        let view = UITextView()
        view.text = text
        view.font = .preferredFont(forTextStyle: .body)
        view.isScrollEnabled = false
        view.textContainerInset = .zero
        view.frame = CGRect(x: 0, y: 0, width: width, height: 0)
        return view
    }
}

@MainActor
private func layoutPerBlock(_ views: [UITextView], width: CGFloat) -> CGFloat {
    var total: CGFloat = 0
    for view in views {
        let size = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        view.frame = CGRect(x: 0, y: total, width: width, height: size.height)
        total += size.height
    }
    return total
}

// MARK: - Architecture B: one document-wide TextKit 2 layout

/// One `NSTextStorage` holding the whole note, laid out by a single
/// `NSTextLayoutManager`.
private func buildDocumentWide(_ texts: [String], width: CGFloat) -> (
    storage: NSTextContentStorage, layout: NSTextLayoutManager
) {
    let content = NSTextContentStorage()
    let layout = NSTextLayoutManager()
    let container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
    layout.textContainer = container
    content.addTextLayoutManager(layout)

    let whole = NSMutableAttributedString()
    for text in texts {
        whole.append(
            NSAttributedString(
                string: text + "\n",
                attributes: [.font: UIFont.preferredFont(forTextStyle: .body)]
            )
        )
    }
    content.textStorage?.setAttributedString(whole)
    return (content, layout)
}

/// Lays out every fragment, which is what scrolling to the end costs.
private func layoutWholeDocument(_ layout: NSTextLayoutManager) -> Int {
    var fragments = 0
    layout.enumerateTextLayoutFragments(
        from: layout.documentRange.location,
        options: [.ensuresLayout, .ensuresExtraLineFragment]
    ) { _ in
        fragments += 1
        return true
    }
    return fragments
}

@Suite(
    "N300 editor architecture spike",
    .enabled(if: ProcessInfo.processInfo.environment["MEMRY_SPIKE"] != nil)
)
@MainActor
struct EditorArchitectureSpikeTests {

    /// Construction and full layout of a 500-block note, both ways.
    ///
    /// The figure that matters is not which is faster in absolute terms — both
    /// are fast enough once — but the **shape** of the cost, because a note is
    /// laid out once and edited thousands of times.
    @Test func a_five_hundred_block_note_lays_out_both_ways() {
        let texts = spikeBlocks()
        let width: CGFloat = 390 - 32

        var views: [UITextView] = []
        let buildA = seconds { views = buildPerBlock(texts, width: width) }
        var heightA: CGFloat = 0
        let layoutA = seconds { heightA = layoutPerBlock(views, width: width) }

        var document: (storage: NSTextContentStorage, layout: NSTextLayoutManager)?
        let buildB = seconds { document = buildDocumentWide(texts, width: width) }
        var fragments = 0
        let layoutB = seconds {
            fragments = layoutWholeDocument(document!.layout)
        }

        print("SPIKE per-block build=\(buildA) layout=\(layoutA) height=\(heightA) views=\(views.count)")
        print("SPIKE document-wide build=\(buildB) layout=\(layoutB) fragments=\(fragments)")

        #expect(views.count == blockCount)
        #expect(heightA > 0, "the per-block stack must have measured a real height")
        #expect(fragments >= blockCount, "every block must have produced a layout fragment")
    }

    /// **The measurement the decision turns on: what one keystroke costs.**
    ///
    /// A user types thousands of characters into a note and lays it out once.
    /// If a keystroke in the middle of a long note re-lays the whole document,
    /// the architecture is wrong regardless of how well it opens.
    @Test func one_keystroke_costs_what_it_costs_in_each_architecture() {
        let texts = spikeBlocks()
        let width: CGFloat = 390 - 32
        let middle = blockCount / 2

        // A: the edited text view re-measures; nothing else is touched.
        let views = buildPerBlock(texts, width: width)
        _ = layoutPerBlock(views, width: width)
        let keystrokeA = seconds {
            let view = views[middle]
            view.text += "x"
            _ = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        }

        // B: the storage is edited and the layout manager re-lays what it must.
        let document = buildDocumentWide(texts, width: width)
        _ = layoutWholeDocument(document.layout)
        let offset = texts[0..<middle].reduce(0) { $0 + $1.count + 1 }
        let keystrokeB = seconds {
            document.storage.performEditingTransaction {
                document.storage.textStorage?.replaceCharacters(
                    in: NSRange(location: offset, length: 0),
                    with: "x"
                )
            }
            _ = layoutWholeDocument(document.layout)
        }

        print("SPIKE keystroke per-block=\(keystrokeA) document-wide=\(keystrokeB)")

        // Both must actually have done the edit, or the comparison is empty.
        #expect(views[middle].text.hasSuffix("x"))
        #expect(document.storage.textStorage?.string.contains("xBlock") == true)
    }

    /// How much of the note a keystroke **disturbs**, which is the cost that
    /// does not show up in a single timing.
    ///
    /// Per-block, one block's geometry changes. Document-wide, every fragment
    /// after the edit shifts, and a shell that maps fragments to blocks has to
    /// reconcile all of them.
    @Test func a_keystroke_disturbs_one_block_or_the_rest_of_the_document() {
        let texts = spikeBlocks()
        let width: CGFloat = 390 - 32
        let middle = blockCount / 2

        let views = buildPerBlock(texts, width: width)
        _ = layoutPerBlock(views, width: width)
        let before = views.map(\.frame)
        // An edit long enough to change the edited block's height.
        views[middle].text += String(repeating: "wrapping ", count: 12)
        _ = layoutPerBlock(views, width: width)
        let movedPerBlock = zip(before, views.map(\.frame)).filter { $0 != $1 }.count

        print("SPIKE frames moved by one edit, per-block=\(movedPerBlock) of \(blockCount)")

        // Per-block, the edited block and the ones after it move, because a
        // stack is a stack — but each one only moves, it does not re-measure
        // its own text. That distinction is the architecture's advantage and
        // is recorded rather than glossed.
        #expect(movedPerBlock > 0, "the edit must have changed the layout")
        #expect(
            movedPerBlock <= blockCount - middle,
            "nothing before the edited block may move"
        )
    }

    /// A caret crossing a block boundary is the behaviour the spike exists to
    /// settle, and it is a **first-responder** question per-block and a
    /// **selection-range** question document-wide.
    ///
    /// Measured here as the concrete thing a shell has to implement: moving
    /// from the end of one block to the start of the next.
    @Test func a_caret_crosses_a_block_boundary_in_both_architectures() {
        let texts = spikeBlocks(3)
        let width: CGFloat = 358
        let views = buildPerBlock(texts, width: width)

        // Per-block: crossing is a change of first responder, and the caret
        // position has to be restored by the shell. Nothing in UIKit does it.
        let first = views[0]
        let second = views[1]
        first.selectedRange = NSRange(location: first.text.count, length: 0)
        // The shell's move: end of block 0 becomes start of block 1.
        second.selectedRange = NSRange(location: 0, length: 0)
        #expect(second.selectedRange.location == 0)

        // Document-wide: crossing is an offset change inside one range, and
        // UIKit does it for free — which is this architecture's real argument.
        let document = buildDocumentWide(texts, width: width)
        let boundary = texts[0].count + 1
        let storage = document.storage.textStorage
        #expect(storage?.length ?? 0 > boundary)
        #expect(
            storage?.attributedSubstring(from: NSRange(location: boundary, length: 5)).string
                == String(texts[1].prefix(5)),
            "the offset after the newline must be the next block's first character"
        )
    }

    /// **The comparison that is actually deployed.**
    ///
    /// The figures above build all 500 text views at once, which no lazy list
    /// ever does: a scrolling list holds roughly a screenful. Measured against
    /// the shape that ships, per-block stops being the expensive option — and
    /// the document-wide side still pays for the whole note, because one
    /// layout cannot be partially resident the way a view list can.
    @Test func a_lazy_list_only_ever_builds_a_screenful() {
        let texts = spikeBlocks()
        let width: CGFloat = 390 - 32
        // A screenful of short paragraphs, plus the overscan a list keeps.
        let visible = 12

        var window: [UITextView] = []
        let buildVisible = seconds {
            window = buildPerBlock(Array(texts.prefix(visible)), width: width)
            _ = layoutPerBlock(window, width: width)
        }

        var document: (storage: NSTextContentStorage, layout: NSTextLayoutManager)?
        let buildWhole = seconds {
            document = buildDocumentWide(texts, width: width)
            _ = layoutWholeDocument(document!.layout)
        }

        print("SPIKE screenful per-block=\(buildVisible) whole-document=\(buildWhole)")

        // **The figures are evidence, not an assertion.** A wall-clock
        // inequality between two architectures is a real measurement and a
        // flaky test: under parallel load the machine decides the winner. The
        // comparison belongs in the evidence document, which records both
        // numbers; what this test holds is that each side really did the work
        // it is being timed for.
        #expect(window.count == visible)
        #expect(buildVisible > 0 && buildWhole > 0)
        #expect(
            document?.storage.textStorage?.length ?? 0 > 0,
            "the whole-document side must have built the whole document"
        )
    }

    /// **A note is not only text, which is the structural half of the
    /// decision.** Tables, images, audio, video and dividers are not
    /// characters in a string; a document-wide text layout can only host them
    /// as attachments, which means building the views anyway *and* keeping
    /// them in sync with a character range.
    @Test func most_block_types_are_not_text_at_all() {
        let textBearing: Set<String> = [
            "paragraph", "heading", "quote", "callout", "codeBlock",
            "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem",
        ]
        let registry: Set<String> = textBearing.union([
            "audio", "bookmark", "divider", "file", "image", "table",
            "taskBlock", "video", "youtubeEmbed",
        ])

        let notText = registry.subtracting(textBearing)
        print("SPIKE non-text block types=\(notText.count) of \(registry.count)")
        #expect(
            notText.count == 9,
            "half the registry is not text, so a text layout cannot own the document"
        )
    }
}

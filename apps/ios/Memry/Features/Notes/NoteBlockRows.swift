import MemryCore
import SwiftUI
import UIKit

// The rows one block kind draws, split from `NoteBlockView.swift`.

/// The body font, or nothing so the surrounding font shows through.
///
/// A modifier rather than `.font(nil)`: a `nil` font is not "inherit", it
/// resets to the system default and throws away the weight a header cell set.
struct BodyFont: ViewModifier {
    let skip: Bool

    func body(content: Content) -> some View {
        if skip {
            content
        } else {
            content.font(Tokens.Typography.body.font)
        }
    }
}

/// A block's declared ink, or nothing so the surrounding ink shows through.
struct BlockInk: ViewModifier {
    let color: Color?

    func body(content: Content) -> some View {
        if let color {
            content.foregroundStyle(color)
        } else {
            content
        }
    }
}

struct ListItemRow: View {
    let marker: String
    let text: AttributedString
    var alignment: TextAlignment = .leading

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Text(marker)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                // A fixed lane, so every marker in a list shares one edge.
                // Numbers past single digits need more than a bullet does.
                .frame(minWidth: Tokens.Space.inset, alignment: .trailing)
                // Hidden from VoiceOver but read in the value below, so the
                // position is spoken once rather than as a stray "3 dot".
                .accessibilityHidden(true)
            Text(text).multilineTextAlignment(alignment)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(String(text.characters))
        .accessibilityValue(marker.hasSuffix(".") ? "Item \(marker.dropLast())" : "")
    }
}

/// A toggle's summary line and the state the note was left in.
struct ToggleSummaryRow: View {
    let isOpen: Bool
    let text: AttributedString
    var alignment: TextAlignment = .leading
    var toggle: (() -> Void)?

    var body: some View {
        if let toggle {
            row
                .contentShape(.rect)
                .onTapGesture(perform: toggle)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint(isOpen ? "Hides its contents" : "Shows its contents")
        } else {
            row
        }
    }

    private var row: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(minWidth: Tokens.Space.inset, alignment: .trailing)
                .accessibilityHidden(true)
            Text(text).multilineTextAlignment(alignment)
        }
        .accessibilityElement(children: .combine)
        // Said in words: the chevron is the only other cue, and a rotation is
        // never allowed to be the one that carries the state.
        .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
    }
}

struct CheckItemRow: View {
    let isChecked: Bool
    let text: AttributedString

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Image(systemName: isChecked ? "checkmark.square" : "square")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(isChecked
                    ? Tokens.Text.secondary.color
                    : Tokens.Line.focus.color)
                .accessibilityHidden(true)
            Text(text)
                .strikethrough(isChecked, color: Tokens.Text.secondary.color)
        }
        .accessibilityElement(children: .combine)
        // Said in words: the tick is the only other cue, and colour is never
        // allowed to be the one that carries it.
        .accessibilityValue(isChecked ? "Done" : "Not done")
    }
}

struct QuoteRow: View {
    let text: AttributedString

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.medium) {
            Rectangle()
                .fill(Tokens.Line.border.color)
                .frame(width: 3)
                .accessibilityHidden(true)
            Text(text)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct CalloutRow: View {
    let type: String
    let text: AttributedString

    private var symbol: String {
        switch type {
        case "warning": "exclamationmark.triangle"
        case "error": "xmark.circle"
        case "success": "checkmark.circle"
        default: "info.circle"
        }
    }

    /// Desktop's callout colours: blue, amber, red and green, carried by the
    /// symbol, a leading bar and a tinted fill. The symbol keeps the type
    /// readable in greyscale and under a colour-blind eye.
    private var hue: String {
        switch type {
        case "warning": "yellow"
        case "error": "red"
        case "success": "green"
        default: "blue"
        }
    }

    private var ink: Color {
        (Tokens.Content.ink(named: hue) ?? Tokens.Text.secondary).color
    }

    private var fill: Color {
        (Tokens.Content.fill(named: hue) ?? Tokens.Canvas.surface).color
    }

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(ink)
                .accessibilityHidden(true)
            Text(text)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(fill)
        .overlay(alignment: .leading) {
            Rectangle().fill(ink).frame(width: 3).accessibilityHidden(true)
        }
        .clipShape(.rect(cornerRadius: Tokens.Radius.control))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(type) callout")
    }
}

struct CodeRow: View {
    let language: String?
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(Tokens.Typography.technicalCaption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            // Horizontal scroll, not wrapping: indentation is part of code,
            // and a wrapped line loses it.
            ScrollView(.horizontal, showsIndicators: false) {
                // Coloured per language, as desktop's shiki colours it.
                Text(CodeHighlighter.attributed(text, language: language))
                    .font(Tokens.Typography.recoveryMaterial.font)
                    .textSelection(.enabled)
            }
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
    }
}

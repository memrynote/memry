import SwiftUI

// The capture sheet (Paper "Quick capture", flow A): write first, choose where
// it goes after. The text field has the focus the moment the sheet opens; the
// destination chips sit above the keyboard with Inbox picked, so saving
// something not yet sorted is one tap. A page's own "+" shows one kind and no
// chips.

struct QuickCaptureSheet: View {
    let kinds: [CaptureKind]
    let capture: QuickCapture
    let captured: (CaptureReceipt) -> Void

    @State private var kind: CaptureKind
    @State private var text = ""
    @State private var saving = false
    @State private var failed = false
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    init(kinds: [CaptureKind], capture: QuickCapture, captured: @escaping (CaptureReceipt) -> Void) {
        self.kinds = kinds
        self.capture = capture
        self.captured = captured
        _kind = State(initialValue: kinds.first ?? .note)
    }

    private var canSave: Bool {
        !saving && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField(
                kinds == [.journal] ? QuickCaptureCopy.journalPlaceholder : QuickCaptureCopy.placeholder,
                text: $text,
                axis: .vertical
            )
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .lineLimit(3 ... 8)
            .focused($focused)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.top, Tokens.Space.section)
            .accessibilityIdentifier("capture.field")
            if failed {
                Text(QuickCaptureCopy.failed)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .padding(.horizontal, Tokens.Space.screenInline)
                    .padding(.top, Tokens.Space.small)
            }
            Spacer(minLength: Tokens.Space.medium)
            HStack(spacing: Tokens.Space.small) {
                if kinds.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Tokens.Space.small) {
                            ForEach(kinds) { option in chip(option) }
                        }
                    }
                } else {
                    Spacer()
                }
                SheetConfirmButton(label: QuickCaptureCopy.send, isEnabled: canSave) { save() }
                    .accessibilityIdentifier("capture.send")
            }
            .padding(.horizontal, Tokens.Space.inset)
            .padding(.vertical, Tokens.Space.small)
        }
        .background(Tokens.Canvas.background.color)
        .presentationDetents([.height(240), .medium])
        .presentationDragIndicator(.visible)
        .onAppear { focused = true }
    }

    private func chip(_ option: CaptureKind) -> some View {
        let isOn = option == kind
        return Button { kind = option } label: {
            Text(option.title)
                .font(Tokens.Typography.supporting.font.weight(.medium))
                .foregroundStyle(isOn ? Tokens.Canvas.background.color : Tokens.Text.primary.color)
                .padding(.horizontal, Tokens.Space.medium)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .background(isOn ? Tokens.Text.primary.color : Tokens.Canvas.surface.color, in: .capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("capture.kind.\(option.rawValue)")
    }

    private func save() {
        guard canSave else { return }
        saving = true
        failed = false
        let text = text
        let kind = kind
        Task {
            let receipt = await capture.capture(text, as: kind)
            saving = false
            guard let receipt else {
                failed = true
                return
            }
            dismiss()
            captured(receipt)
        }
    }
}

/// The confirmation a capture leaves on the page it started from: what was
/// filed where, and a way to go there.
struct CaptureToast: View {
    let receipt: CaptureReceipt
    let view: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Text(receipt.message)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(QuickCaptureCopy.view, action: view)
                .font(Tokens.Typography.supporting.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityIdentifier("capture.toast.view")
        }
        .padding(.horizontal, Tokens.Space.medium)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .chromeGlass(in: .capsule)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("capture.toast")
    }
}

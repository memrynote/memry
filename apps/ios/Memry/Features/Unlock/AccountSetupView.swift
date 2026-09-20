import SwiftUI

// The two screens a brand-new account sees, and the route out of the dead end
// a fresh signup used to hit.
//
// **The phrase fits on one screen, deliberately.** Twenty-four words in two
// columns with no scroll: a user copying words onto paper must be able to see
// all of them at once, and a list they have to scroll is a list they transcribe
// half of. The words are the smallest type on the screen that still reads at a
// glance, because the sentence above them is what the user has to act on.
//
// **Copy is offered, and what it costs is said.** The clipboard is shared with
// every app and, on a signed-in Mac, with that Mac. That is a real trade and
// the user makes it; hiding the button would push them to a screenshot, which
// lands in a photo library that syncs.
//
// **Nothing here is reachable by accident.** The account is not set up until
// three words come back, so a user who leaves at the phrase screen leaves with
// the account exactly as they found it.

struct AccountSetupView: View {
    @Bindable var model: AccountSetupViewModel
    /// Called when this device holds the key: the caller routes on to vaults.
    let onEstablished: () -> Void
    /// Called when the account turned out to have key material already: the
    /// caller shows the unlock route instead.
    let onAlreadyConfigured: () -> Void

    var body: some View {
        Group {
            switch model.phase {
            case .checking:
                // Words, never a bare spinner: this is a network round trip and
                // the sentence says which question is being asked.
                ProgressView { Text("Checking this account") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .phrase(words):
                PhraseScreen(words: words) { model.continueToConfirmation() }
            case .confirming:
                ConfirmWordsScreen(model: model)
            case .establishing:
                ProgressView { Text("Setting up your account") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .established:
                Color.clear.onAppear(perform: onEstablished)
            case .alreadyConfigured:
                Color.clear.onAppear(perform: onAlreadyConfigured)
            case let .failed(error):
                SetupFailureScreen(error: error) { Task { await model.startOver() } }
            }
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.phase)
        .task { await model.begin() }
    }
}

/// The phrase itself: one screen, no scroll, one action.
private struct PhraseScreen: View {
    let words: String
    let onWrittenDown: () -> Void

    @State private var didCopy = false

    private var columns: [[(index: Int, word: String)]] {
        let all = words.split(separator: " ").enumerated().map { ($0.offset, String($0.element)) }
        let half = (all.count + 1) / 2
        return [Array(all.prefix(half)), Array(all.dropFirst(half))]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.inset) {
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                Text("Write these 24 words down")
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityAddTraits(.isHeader)
                // The consequence, in the place the decision is made. It is not
                // a warning banner: it is the sentence that explains the
                // screen.
                Text("They are the only way back into your notes. Memry cannot reset them, and nobody else has them.")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)

            HStack(alignment: .top, spacing: Tokens.Space.medium) {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                    VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                        ForEach(column, id: \.index) { entry in
                            WordLine(number: entry.index + 1, word: entry.word)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            // Key material: kept out of the redacted renderings the system
            // takes for the app switcher and for screen recording.
            .privacySensitive()

            Spacer(minLength: 0)

            Button {
                UIPasteboard.general.string = words
                didCopy = true
            } label: {
                Label(didCopy ? "Copied" : "Copy to clipboard", systemImage: didCopy ? "checkmark" : "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .memrySecondaryAction()

            Text("The clipboard is shared with other apps, and with a Mac signed into the same Apple Account. Paper is safer.")
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)

            Button("I have written them down", action: onWrittenDown)
                .memryPrimaryAction()
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.vertical, Tokens.Space.inset)
    }
}

/// One numbered word. The number is a lane of its own so the two columns line
/// up whatever the word lengths are.
private struct WordLine: View {
    let number: Int
    let word: String

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Text(number.formatted())
                .font(Tokens.Typography.technicalCaption.font.monospacedDigit())
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(width: Tokens.Space.section, alignment: .trailing)
            Text(word)
                .font(Tokens.Typography.recoveryMaterial.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Word \(number), \(word)")
    }
}

/// Three words back, typed.
///
/// Typed and not tapped: a multiple choice can be guessed at one in four, and
/// the thing being checked is that the phrase left the screen with the user.
private struct ConfirmWordsScreen: View {
    @Bindable var model: AccountSetupViewModel

    @State private var typed: [Int: String] = [:]
    @FocusState private var focused: Int?

    private var allCorrect: Bool {
        !model.confirmationIndices.isEmpty
            && model.confirmationIndices.allSatisfy { index in
                model.isCorrect(typed[index] ?? "", at: index)
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.section) {
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                Text("Type three of them back")
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityAddTraits(.isHeader)
                Text("So we both know the words left this screen with you.")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .accessibilityElement(children: .combine)

            VStack(alignment: .leading, spacing: Tokens.Space.inset) {
                ForEach(model.confirmationIndices, id: \.self) { index in
                    WordCheckField(
                        number: index + 1,
                        text: Binding(
                            get: { typed[index] ?? "" },
                            set: { typed[index] = $0 }
                        ),
                        isCorrect: model.isCorrect(typed[index] ?? "", at: index),
                        focus: $focused
                    )
                }
            }

            Spacer(minLength: 0)

            Button("Finish setup") {
                focused = nil
                Task { await model.establish() }
            }
            .memryPrimaryAction()
            .disabled(!allCorrect)

            Button("Show the words again") { model.showPhraseAgain() }
                .font(Tokens.Typography.supporting.font)
                .tint(Tokens.Text.primary.color)
                .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.vertical, Tokens.Space.inset)
        .task { focused = model.confirmationIndices.first }
    }
}

private struct WordCheckField: View {
    let number: Int
    @Binding var text: String
    let isCorrect: Bool
    @FocusState.Binding var focus: Int?

    var body: some View {
        FieldGroup(label: "Word \(number)") {
            HStack(spacing: Tokens.Space.small) {
                TextField("", text: $text)
                    .font(Tokens.Typography.recoveryMaterial.font)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: number - 1)
                    .privacySensitive()
                // The tick is a confirmation, never the only cue: an empty
                // field and a wrong one both simply have no tick, and the
                // button says what is still missing by staying disabled.
                if isCorrect {
                    Image(systemName: "checkmark")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Interaction.actionFill.color)
                        .accessibilityHidden(true)
                }
            }
        }
        .accessibilityValue(isCorrect ? "Correct" : "Not yet")
    }
}

/// Setup stopped. The way on is to ask the server again, never to hand out a
/// second phrase: the first may have been published by the call that failed.
private struct SetupFailureScreen: View {
    let error: UserFacingError
    let retry: () -> Void

    var body: some View {
        NoticeScreen(
            symbol: "exclamationmark.triangle",
            title: error.title,
            detail: error.guidance ?? "Nothing was changed on your account. Try again when you have a connection."
        ) {
            Button("Try again", action: retry)
                .memryPrimaryAction()
        }
    }
}

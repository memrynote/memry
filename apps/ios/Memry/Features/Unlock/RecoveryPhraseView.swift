import MemryCore
import SwiftUI

// T152. The 24-word entry itself.
//
// **One field, not twenty-four.** A recovery phrase arrives by paste — from a
// password manager, from the desktop app's own copy button, from a note the
// user wrote down — and twenty-four separate fields turn one paste into
// twenty-four, break VoiceOver into twenty-four stops and give autocorrect
// twenty-four chances. Chapter 01 §1.3's five normalisation steps are the
// core's, so a field that accepts doubled spaces, newlines and capitals is
// exactly what the protocol already handles: the committed vector
// `bip39-unlock.json` pins a phrase with mixed case, doubled spaces and outer
// padding canonicalising to the same seed.
//
// **The keyboard is disarmed.** Autocorrect changes "bachelor" to something
// else, autocapitalisation makes "Audit" and smart punctuation inserts curly
// characters that come back as `RecoveryError.NonAscii`. All three are off, and
// the keyboard is `.asciiCapable` so a non-ASCII byte is hard to reach at all.
//
// **No word is printed into a message.** When the core names an unknown word,
// the screen marks it *in the text the user typed* and the sentence stays the
// one `ErrorMapping` wrote (`DESIGN.md` §"Error copy, in detail",
// spec-defect 96).
//
// **No Cancel while the derivation runs.** See `RecoveryPhraseUnlock.swift`.
//
// Leading and trailing only — SwiftUI's are logical and flip under RTL —
// semantic fonts so dynamic type works with no fixed frame, mono for recovery
// material (`DESIGN.md` §Typography), and reduce-motion branched at the
// modifier that would otherwise ignore it.
//
// **T160.** Every colour, spacing, radius, duration and font on this screen now
// comes from `Memry/Design`. The private `UnlockErrorNotice` this file carried,
// and the comment saying its home was `Memry/Design` once T160 existed, are
// both gone: it is `ErrorNotice` now, and there is one of it.

struct RecoveryPhraseView: View {
    @Bindable var model: RecoveryPhraseViewModel
    /// Back to `UnlockRouteView`'s chooser. `nil` when there was no choice to
    /// make — with no `DeviceLink` this screen is the whole route, and a Back
    /// leading to a one-item picker is a step that undoes nothing.
    var onBack: (() -> Void)?

    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                header
                field
                if model.highlightedWord != nil {
                    WordReview(words: model.typedWords, highlighted: model.highlightedWord)
                }
                if let error = model.error {
                    ErrorNotice(error: error, code: model.visibleErrorCode)
                }
                actions
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.error)
        .calmAnimation(.normal, value: model.highlightedWord)
        .task { focused = true }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text("Enter your recovery phrase")
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text("The 24 words you saved when you created this account. Memry unlocks on this phone only.")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Two sentences are one thought; VoiceOver should not stop between them
        // and lose the half that says what to do.
        .accessibilityElement(children: .combine)
    }

    private var field: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            FieldGroup(label: "Recovery phrase") {
                TextField("", text: $model.phrase, axis: .vertical)
                    .font(Tokens.Typography.recoveryMaterial.font)
                    .lineLimit(4...8)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .padding(.vertical, Tokens.Space.medium)
                    // Key material: excluded from the redacted renderings the
                    // system takes for app switchers and screen recording.
                    .privacySensitive()
                    .accessibilityLabel("Recovery phrase")
                    .accessibilityHint("Twenty-four words, separated by spaces. Pasting the whole phrase works.")
            }
            Text(counter)
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityLabel(counterLabel)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A count the user can act on, which is what separates it from the
    /// durations and byte counts `DESIGN.md` refuses.
    private var counter: String {
        "\(model.typedWordCount) of \(RecoveryPhraseViewModel.expectedWordCount) words"
    }

    private var counterLabel: String {
        "\(model.typedWordCount) of \(RecoveryPhraseViewModel.expectedWordCount) words entered"
    }

    @ViewBuilder
    private var actions: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            if model.isWorking {
                // Words, not a bare spinner. The 64 MiB derivation takes about a
                // second on a phone and cannot be interrupted, so the screen says
                // what is happening and promises no duration.
                ProgressView { Text("Unlocking your vault") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
            } else {
                Button("Unlock") { submit() }
                    .memryPrimaryAction()
                    .frame(maxWidth: .infinity)
                    .disabled(!model.canSubmit)
                if let onBack {
                    Button("Unlock with a nearby computer instead", action: onBack)
                        .memrySecondaryAction()
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func submit() {
        guard model.canSubmit else { return }
        focused = false
        Task { await model.unlock() }
    }
}

/// The typed words, numbered, with the one the core could not place marked.
///
/// Shown **only** when there is a word to mark. It repeats text that is already
/// on screen and under the user's control, which is the single thing
/// `DESIGN.md` permits here: the sentence still may not contain the word, and
/// does not.
private struct WordReview: View {
    let words: [String]
    let highlighted: Int?

    private let columns = [GridItem(.adaptive(minimum: 104), alignment: .leading)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: Tokens.Space.small) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                let isMarked = index == highlighted
                HStack(spacing: Tokens.Space.tight) {
                    Text("\(index + 1)")
                        .font(Tokens.Typography.technicalCaption.font.monospacedDigit())
                        .foregroundStyle(Tokens.Text.tertiary.color)
                    Text(word)
                        .font(Tokens.Typography.recoveryMaterial.font)
                        .fontWeight(isMarked ? .semibold : .regular)
                        .foregroundStyle(Tokens.Text.primary.color)
                    if isMarked {
                        // Not colour alone: `DESIGN.md` rejects colour as the
                        // only state cue.
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Interaction.destructive.color)
                    }
                }
                .padding(.horizontal, Tokens.Space.small)
                .padding(.vertical, Tokens.Space.tight)
                .overlay(marker(isMarked))
                .accessibilityElement(children: .combine)
                .accessibilityLabel(label(for: index, word, isMarked))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .privacySensitive()
    }

    private func label(for index: Int, _ word: String, _ isMarked: Bool) -> String {
        isMarked ? "Word \(index + 1), \(word), not in the word list" : "Word \(index + 1), \(word)"
    }

    @ViewBuilder
    private func marker(_ isMarked: Bool) -> some View {
        if isMarked {
            RoundedRectangle(cornerRadius: Tokens.Radius.control)
                .strokeBorder(Tokens.Line.focus.color, lineWidth: 2)
        }
    }
}

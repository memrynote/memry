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

struct RecoveryPhraseView: View {
    @Bindable var model: RecoveryPhraseViewModel

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                field
                if model.highlightedWord != nil {
                    WordReview(words: model.typedWords, highlighted: model.highlightedWord)
                }
                if let error = model.error {
                    UnlockErrorNotice(error: error, code: model.visibleErrorCode)
                }
                actions
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .animation(reduceMotion ? nil : .default, value: model.error)
        .animation(reduceMotion ? nil : .default, value: model.highlightedWord)
        .task { focused = true }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Enter your recovery phrase")
                .font(.largeTitle)
                .fontWeight(.semibold)
            Text("The 24 words you saved when you created this account. Memry unlocks on this phone only.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Two sentences are one thought; VoiceOver should not stop between them
        // and lose the half that says what to do.
        .accessibilityElement(children: .combine)
    }

    private var field: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Recovery phrase", text: $model.phrase, axis: .vertical)
                .font(.body.monospaced())
                .lineLimit(4...8)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
                .textFieldStyle(.roundedBorder)
                // Key material: excluded from the redacted renderings the system
                // takes for app switchers and screen recording.
                .privacySensitive()
                .accessibilityLabel("Recovery phrase")
                .accessibilityHint("Twenty-four words, separated by spaces. Pasting the whole phrase works.")
            Text(counter)
                .font(.footnote)
                .foregroundStyle(.secondary)
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
        VStack(alignment: .leading, spacing: 12) {
            if model.isWorking {
                // Words, not a bare spinner. The 64 MiB derivation takes about a
                // second on a phone and cannot be interrupted, so the screen says
                // what is happening and promises no duration.
                ProgressView { Text("Unlocking your vault") }
                    .progressViewStyle(.circular)
            } else {
                Button("Unlock") { submit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canSubmit)
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
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                let isMarked = index == highlighted
                HStack(spacing: 6) {
                    Text("\(index + 1)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Text(word)
                        .font(.callout.monospaced())
                        .fontWeight(isMarked ? .semibold : .regular)
                    if isMarked {
                        // Not colour alone: `DESIGN.md` rejects colour as the
                        // only state cue.
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.caption)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
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
            RoundedRectangle(cornerRadius: 8).strokeBorder(.tint, lineWidth: 2)
        }
    }
}

/// One failure, rendered.
///
/// A near-twin of `SignInView`'s private `ErrorNotice`, deliberately duplicated
/// rather than shared from another feature's file: the shared component belongs
/// in `Memry/Design` and that file is T160's. Both render `UserFacingError` and
/// nothing else, which is the part that is not allowed to diverge.
private struct UnlockErrorNotice: View {
    let error: UserFacingError
    /// Non-`nil` only for an error with no mapping, which `DESIGN.md` requires
    /// to render an identifying code. Every other message keeps its code in the
    /// log, where it is useful, and off the screen, where it is clutter.
    let code: String?

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(error.title, systemImage: symbol)
                .font(.headline)
            if let guidance = error.guidance {
                Text(guidance)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let code {
                Text(code)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(fill, in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(error.text)
    }

    private var fill: AnyShapeStyle {
        reduceTransparency ? AnyShapeStyle(.background.secondary) : AnyShapeStyle(.regularMaterial)
    }

    private var symbol: String {
        switch error.recourse {
        case .retry: "arrow.clockwise"
        case .retryLater: "clock"
        case .blocked: "exclamationmark.triangle"
        }
    }
}

import MemryCore
import SwiftUI

// T147. Email one-time code entry.
//
// **Paste and typing are the mechanism; autofill is a bonus** (research R14).
// `.textContentType(.oneTimeCode)` is set, and it is undocumented and arrives
// 10 to 15 seconds late when it arrives at all, so nothing on this screen
// depends on it: the field is an ordinary editable field, a pasted "your code
// is 123456" is read, and the button is live the moment there is text.
//
// **Every state shown is one the core reported.** The screen renders
// ``SignInStep``, a total mapping of the nine states in `data-model.md` §C.1,
// and `SignInViewModel` re-reads the state from the core after every call —
// including after a failure, where the core has already moved.
//
// **No raw error reaches the screen** (Constitution II). The only sentences
// here come from `ErrorMapping`, from `SignInErrors`, or from a `SignInStep`
// written against `DESIGN.md`.
//
// Leading and trailing throughout — SwiftUI's are logical and flip under RTL —
// semantic fonts so dynamic type works without a fixed frame anywhere, and
// reduce-motion and reduce-transparency branched at the modifier that would
// otherwise ignore them.

struct SignInView: View {
    @Bindable var model: SignInViewModel

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focus: SignInStep.Field?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                field
                if let error = model.error {
                    ErrorNotice(error: error, code: model.visibleErrorCode)
                }
                actions
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        // Reduce-motion branches here rather than inside the animation, so the
        // transition is genuinely absent rather than shortened.
        .animation(reduceMotion ? nil : .default, value: model.step)
        .animation(reduceMotion ? nil : .default, value: model.error)
        .task { focus = focusTarget }
        .onChange(of: model.step.field) { focus = focusTarget }
    }

    private var focusTarget: SignInStep.Field? {
        model.step.field == .absent ? nil : model.step.field
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.step.title)
                .font(.largeTitle)
                .fontWeight(.semibold)
            Text(model.step.detail)
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Two sentences read as one thought; VoiceOver should not stop between
        // them and lose the half that says what to do.
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var field: some View {
        switch model.step.field {
        case .email:
            TextField("Email address", text: $model.email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .onSubmit { act(.sendCode) }
                .focused($focus, equals: .email)
                .textFieldStyle(.roundedBorder)
        case .code:
            // `.numberPad` has no return key, which is why the button and not
            // `onSubmit` is the mechanism. Paste still works on it, and so does
            // one-time-code autofill when it eventually arrives.
            TextField("Six-digit code", text: $model.code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .focused($focus, equals: .code)
                .textFieldStyle(.roundedBorder)
        case .absent:
            EmptyView()
        }
    }

    @ViewBuilder
    private var actions: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let running = model.runningAction {
                // Words, not a bare spinner: this wait can run into minutes
                // behind the server's rate limiter and cannot be cancelled.
                ProgressView { Text(running.progressLabel) }
                    .progressViewStyle(.circular)
            } else {
                if let primary = model.step.primary {
                    Button(primary.label) { act(primary) }
                        .buttonStyle(.borderedProminent)
                        .disabled(!model.isEnabled(primary))
                }
                if let secondary = model.step.secondary {
                    Button(secondary.label) { act(secondary) }
                        .buttonStyle(.bordered)
                        .disabled(!model.isEnabled(secondary))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func act(_ action: SignInAction) {
        guard model.isEnabled(action) else { return }
        Task { await model.run(action) }
    }
}

/// One failure, rendered.
///
/// The icon carries the recourse as well as the colour would, which is the
/// point: `DESIGN.md` rejects colour as the only state cue.
private struct ErrorNotice: View {
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
        // `text` is title and guidance as one sentence, which is what this type
        // has it for: an alert read as two unrelated fragments loses the half
        // that matters.
        .accessibilityLabel(error.text)
    }

    /// Branched at the modifier, not at a theme: a translucent surface under
    /// reduce-transparency is the setting being ignored.
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

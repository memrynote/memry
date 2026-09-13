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
//
// **T160.** Every colour, spacing, radius, duration and font on this screen now
// comes from `Memry/Design`. The private `ErrorNotice` this file used to carry
// is the shared one, and the reduce-motion branch that was written out inline
// here is `calmAnimation`, which takes it inside its own `body` — same
// behaviour, one place.

struct SignInView: View {
    @Bindable var model: SignInViewModel

    @FocusState private var focus: SignInStep.Field?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                header
                field
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
        .calmAnimation(.normal, value: model.step)
        .calmAnimation(.normal, value: model.error)
        .task { focus = focusTarget }
        .onChange(of: model.step.field) { focus = focusTarget }
    }

    private var focusTarget: SignInStep.Field? {
        model.step.field == .absent ? nil : model.step.field
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(model.step.title)
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text(model.step.detail)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
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
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            if let running = model.runningAction {
                // Words, not a bare spinner: this wait can run into minutes
                // behind the server's rate limiter and cannot be cancelled.
                ProgressView { Text(running.progressLabel) }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
            } else {
                if let primary = model.step.primary {
                    Button(primary.label) { act(primary) }
                        .memryPrimaryAction()
                        .disabled(!model.isEnabled(primary))
                }
                if let secondary = model.step.secondary {
                    Button(secondary.label) { act(secondary) }
                        .memrySecondaryAction()
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

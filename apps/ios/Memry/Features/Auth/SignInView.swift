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
    /// Back to the welcome screens. `nil` once there is nothing behind this —
    /// a session that expired lands here too, and that is an interruption
    /// rather than a first run.
    var onBack: (() -> Void)?

    @FocusState private var focus: SignInStep.Field?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                if let onBack {
                    BackButton(action: onBack)
                }
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

    /// **The code field takes focus; the email field does not.**
    ///
    /// A keyboard on arrival covered Apple and Google entirely, so the first
    /// screen of the app offered one way in out of three and hid the two that
    /// are a single tap. By the time the code step is on screen the user has
    /// already chosen email, there is nothing else to pick, and the keyboard is
    /// the only thing they want.
    private var focusTarget: SignInStep.Field? {
        model.step.field == .code ? .code : nil
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
            FieldGroup(label: "Email") {
                // `prompt:`, not the title argument: a bare placeholder string
                // is drawn in the system accent, which put a blue example
                // address on a screen with no blue anywhere else.
                TextField(
                    "",
                    text: $model.email,
                    prompt: Text("you@example.com").foregroundStyle(Tokens.Text.secondary.color)
                )
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .onSubmit { act(.sendCode) }
                    .focused($focus, equals: .email)
            }
        case .code:
            // `.numberPad` has no return key, which is why the button and not
            // `onSubmit` is the mechanism. Paste still works on it, and so does
            // one-time-code autofill when it eventually arrives.
            FieldGroup(label: "Six-digit code") {
                TextField(
                    "",
                    text: $model.code,
                    prompt: Text("000000").foregroundStyle(Tokens.Text.secondary.color)
                )
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .font(Tokens.Typography.recoveryMaterial.font)
                    .focused($focus, equals: .code)
            }
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
                        .frame(maxWidth: .infinity)
                        .disabled(!model.isEnabled(primary))
                }
                if let secondary = model.step.secondary {
                    // The provider is an alternative to the email code, not a
                    // step after it, and the rule says so. Every other
                    // secondary action on this screen continues the same
                    // thought and gets no divider.
                    if secondary == .signInWithGoogle {
                        OrDivider()
                        providers
                    } else {
                        Button(secondary.label) { act(secondary) }
                            .memrySecondaryAction()
                            .disabled(!model.isEnabled(secondary))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The two provider buttons, in the shape Memry's own actions have.
    ///
    /// **Apple is offered and cannot be pressed, on purpose.** `AuthProvider`
    /// in the core has one case and `apps/sync-server` verifies Google ID
    /// tokens only, so a live button would open a sheet whose token nothing can
    /// exchange. `DESIGN.md` asks for "a clear limitation instead of a dead
    /// control", which is the disabled button plus the sentence under it. It
    /// becomes live the moment `AuthProvider.apple` exists.
    private var providers: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            ProviderButton(provider: .apple) {}
                .disabled(true)
            ProviderButton(provider: .google) { act(.signInWithGoogle) }
                .disabled(!model.isEnabled(.signInWithGoogle))
            Text("Signing in with Apple is not ready yet. Use your email or Google for now.")
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func act(_ action: SignInAction) {
        guard model.isEnabled(action) else { return }
        Task { await model.run(action) }
    }
}

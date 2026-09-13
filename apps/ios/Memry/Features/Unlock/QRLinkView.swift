import MemryCore
import SwiftUI

// T153. The scan screen: the phone's half of chapter 03, and the screen that
// gives `DeviceLink` its production caller.
//
// **Manual entry is not a nicety and is not hidden.** The camera does not
// exist in CI and does not exist on the simulator — `AVCaptureDevice.default`
// returns `nil` there — so a flow that treats typing as a fallback behind a
// disclosure is a flow that cannot be exercised anywhere but a phone
// (research R13). The field is on the screen, always, with its own label and
// its own button.
//
// **A camera that cannot be used says so.** `CaptureError.NotPermitted` and
// `.Restricted` already have copy that distinguishes "allow it in Settings"
// from "a profile controls this and you cannot"; neither can render as "no
// code found", because the scan is never started.
//
// **There is no viewfinder, and that is a gap rather than a choice.** T146's
// seam exposes `scan()` and nothing else — no `AVCaptureVideoPreviewLayer`,
// no preview view — so this screen can say the camera is running but cannot
// show what it sees. Reported to the orchestrator.
//
// Logical leading/trailing only, semantic fonts, every value from `Tokens`.

struct QRLinkView: View {
    @Bindable var model: DeviceLinkingViewModel
    /// Back to the recovery-phrase screen, which is the other way in.
    let onUsePhrase: () -> Void

    var body: some View {
        Group {
            switch model.phase {
            case .confirming, .expired, .linked:
                SASConfirmView(model: model)
            case .alreadyLinked:
                AlreadyLinkedNotice()
            default:
                scanScreen
            }
        }
        .calmAnimation(.normal, value: model.phase)
        .task { model.begin() }
    }

    private var scanScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                header
                cameraSection
                manualSection
                if let error = model.error {
                    ErrorNotice(error: error, code: model.visibleErrorCode)
                }
                Button("Use my recovery phrase instead") { onUsePhrase() }
                    .memrySecondaryAction()
                    .disabled(model.isWorking)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.error)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text("Unlock with a nearby computer")
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text(
                "On a computer where Memry is already unlocked, open Settings and choose "
                    + "Link a device. Scan the code it shows, or paste it below."
            )
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Text.secondary.color)
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    // MARK: - The camera

    @ViewBuilder
    private var cameraSection: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            switch model.phase {
            case .scanning:
                // Words, not a bare spinner, and a Stop that stops something
                // real: this is the shell's own call, so cancelling it is
                // honest. The core's `scan` is a different case — see below.
                ProgressView { Text("Point the camera at the code on your computer") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
                Button("Stop scanning") { model.stopScanning() }
                    .memrySecondaryAction()
            case .submitting:
                // **No Stop here.** `DeviceLink.scan` is an async core call and
                // the bindings carry no `rust_future_cancel` (spec-defect 108),
                // so a button offering to stop it would be a lie.
                ProgressView { Text("Checking that code") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
            default:
                Button("Scan the code") { Task { await model.scanWithCamera() } }
                    .memryPrimaryAction()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - The fallback that is not a fallback

    private var manualSection: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text("Or paste the code")
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text("Your computer offers a copy button beside the code. It is long; pasting is the way in.")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            TextField("Linking code", text: $model.typedPayload, axis: .vertical)
                .font(Tokens.Typography.recoveryMaterial.font)
                .lineLimit(3...6)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                // The payload carries a 256-bit one-time secret: kept out of
                // the redacted renderings the system takes for the app
                // switcher and for screen recording.
                .privacySensitive()
                .accessibilityLabel("Linking code")
                .accessibilityHint("Paste the code your computer is showing.")
            Button("Continue") { Task { await model.submitTypedPayload() } }
                .memryPrimaryAction()
                .disabled(!model.canSubmitTypedPayload)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

/// The T154 edge case, on screen.
///
/// A phone that already holds the account's master key is already linked for
/// every vault (chapter 01 §1.6, §1.7), and linking again would resolve to a
/// second registration against a 50-device budget. So the screen says the
/// phone is already linked rather than offering a scan that must not happen.
private struct AlreadyLinkedNotice: View {
    var body: some View {
        ContentUnavailableView {
            Label("This phone is already linked", systemImage: "checkmark.seal")
        } description: {
            Text("It already holds this account's key, so there is nothing to scan. Your vaults are ready.")
        }
    }
}

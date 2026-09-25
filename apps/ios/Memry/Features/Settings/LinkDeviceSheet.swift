import CoreImage.CIFilterBuiltins
import MemryCore
import SwiftUI
import UIKit

// Spec 006 ST36, artboard 07 and flow lane 04. This phone is the approver:
// it shows a code, waits for the new device to scan, asks to approve with the
// six-digit check both screens show, then seals the key (`DeviceApprover`).
// Each core call is one request; the poll is this sheet's own timer, so closing
// the sheet stops it (spec-defect 108).
struct LinkDeviceSheet: View {
    let account: AccountModel
    @Environment(\.dismiss) private var dismiss
    @State private var approver: DeviceApprover?
    @State private var invite: LinkingInvite?
    @State private var status: ApproverStatus = .waiting
    @State private var failure: UserFacingError?
    @State private var now = Date.now
    @State private var approving = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Tokens.Space.section) {
                    Text(SettingsCopy.linkInstruction)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .multilineTextAlignment(.center)
                    if let invite {
                        code(invite)
                    } else if failure == nil {
                        ProgressView()
                    }
                    if let failure { ErrorNotice(error: failure, code: nil) }
                    Text(statusLine)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("settings.link.status")
                }
                .padding(Tokens.Space.screenInline)
            }
            .navigationTitle(SettingsCopy.linkNewDevice)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(SettingsCopy.cancel, systemImage: "xmark") { close() }
                        .accessibilityIdentifier("settings.link.close")
                }
            }
            .alert(SettingsCopy.approveTitle, isPresented: $approving) {
                Button(SettingsCopy.cancel, role: .cancel) { close() }
                Button(SettingsCopy.approve) { Task { await approve() } }
            } message: {
                if case let .scanned(code) = status { Text(SettingsCopy.approveMessage(code)) }
            }
        }
        .presentationDetents([.large])
        .task { await start() }
    }

    private func code(_ invite: LinkingInvite) -> some View {
        VStack(spacing: Tokens.Space.medium) {
            if let image = Self.qr(invite.qrPayload) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 240)
                    .padding(Tokens.Space.medium)
                    .background(Color.white, in: .rect(cornerRadius: Tokens.Radius.card))
                    .accessibilityLabel(SettingsCopy.linkNewDevice)
            }
            Text(SettingsCopy.orEnterCode)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            Button(SettingsCopy.copyCode, systemImage: "doc.on.doc") {
                UIPasteboard.general.string = invite.qrPayload
            }
            .buttonStyle(.bordered)
            .privacySensitive()
            Text(SettingsCopy.expiresIn(remaining(invite)))
                .font(Tokens.Typography.technicalCaption.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .monospacedDigit()
        }
    }

    private var statusLine: String {
        switch status {
        case .waiting: SettingsCopy.linkWaiting
        case .scanned: SettingsCopy.approveTitle
        case .done: SettingsCopy.linked
        case .expired: SettingsCopy.linkExpired
        }
    }

    private func remaining(_ invite: LinkingInvite) -> String {
        let left = max(0, Int(invite.expiresAt) - Int(now.timeIntervalSince1970))
        return String(format: "%d:%02d", left / 60, left % 60)
    }

    private func start() async {
        guard let approver = account.approver() else { return }
        self.approver = approver
        do {
            invite = try await approver.initiate()
        } catch {
            failure = ErrorMapping.userFacing(error)
            return
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3))
            now = .now
            guard !Task.isCancelled, !approving, status == .waiting else { continue }
            do {
                status = try await approver.status()
                if case .scanned = status { approving = true }
            } catch {
                failure = ErrorMapping.userFacing(error)
            }
            if status == .expired || status == .done { return }
        }
    }

    private func approve() async {
        guard let approver else { return }
        do {
            try await approver.approve()
            status = .done
            try? await Task.sleep(for: .seconds(1))
            dismiss()
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }

    private func close() {
        approver?.cancel()
        dismiss()
    }

    static func qr(_ payload: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cgImage = CIContext().createCGImage(output, from: output.extent)
        else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

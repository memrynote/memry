import SwiftUI
import UniformTypeIdentifiers

/// The vault open offline was removed from the account while this device was
/// away. Its files are still here; nothing on this screen deletes them. Export
/// copies them to a folder the user picks in Files (#5600).
struct RemovedVaultNotice: View {
    let export: RemovedVaultExport
    let dismiss: () -> Void
    @State private var choosingFolder = false

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text("That vault was removed from your account. Its copy stays on this \(ThisDevice.noun).")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            status
            if export.isCopying {
                Button("Cancel export", action: export.cancel)
                    .memrySecondaryAction()
            } else {
                Button("Export a copy to Files") { choosingFolder = true }
                    .memrySecondaryAction()
                    .accessibilityHint("Copies this vault's files to a folder you choose. The copy here stays.")
                Button("Dismiss", action: dismiss)
                    .memrySecondaryAction()
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .calmAnimation(.normal, value: export.phase)
        .fileImporter(isPresented: $choosingFolder, allowedContentTypes: [.folder]) { result in
            switch result {
            case let .success(folder): export.start(into: folder)
            case .failure: export.pickerFailed()
            }
        }
    }

    @ViewBuilder private var status: some View {
        switch export.phase {
        case .idle:
            EmptyView()
        case let .copying(done, total):
            ProgressView(value: Double(done), total: Double(max(total, 1))) {
                Text(total == 0 ? "Preparing the copy" : "Copying \(done) of \(total) files")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .tint(Tokens.Text.secondary.color)
        case let .exported(folder):
            Label("Exported to \(folder).", systemImage: "checkmark.circle")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.primary.color)
        case let .failed(error):
            ErrorNotice(error: error, code: nil)
        }
    }
}

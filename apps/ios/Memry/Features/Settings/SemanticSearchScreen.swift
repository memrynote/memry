import MemryCore
import SwiftUI

struct SemanticSearchScreen: View {
    let vault: Vault
    let executor: CoreExecutor
    @Environment(\.semanticSearch) private var semantic

    var body: some View {
        if let semantic {
            SemanticSearchPage(model: SemanticSearchModel(
                semantic: semantic,
                vault: vault,
                executor: executor,
                availableBytes: { try VaultFiles(emitter: CoreEventEmitter { _ in }).availableBytes() }
            ))
        } else {
            List { Section { ErrorNotice(error: ErrorMapping.semanticNoStorage, code: nil) } }
                .settingsList()
                .navigationTitle(SemanticSearchCopy.title)
        }
    }
}

private struct SemanticSearchPage: View {
    @State var model: SemanticSearchModel
    @State private var confirmingOff = false

    var body: some View {
        List {
            if let display = model.display {
                Section {
                    SettingsToggleRow(
                        title: SemanticSearchCopy.toggle,
                        detail: SemanticSearchCopy.toggleDetail,
                        isOn: Binding(get: { display.isOn }, set: toggle),
                        identifier: "settings.semanticSearch.toggle"
                    )
                    .disabled(model.pending != nil)
                    if let row = display.row { stateRow(row) }
                } footer: {
                    SettingsFooter(SemanticSearchCopy.footer(size: display.size))
                }
                .confirmationDialog(
                    SemanticSearchCopy.turnOffTitle, isPresented: $confirmingOff, titleVisibility: .visible
                ) {
                    Button(SemanticSearchCopy.turnOffConfirm, role: .destructive) {
                        Task { await model.turnOff() }
                    }
                } message: {
                    Text(SemanticSearchCopy.turnOffMessage(size: display.size))
                }
            } else {
                Section { ProgressView() }
            }
            if let failure = model.failure {
                Section { ErrorNotice(error: failure, code: nil) }
            }
        }
        .settingsList()
        .navigationTitle(SemanticSearchCopy.title)
        .accessibilityIdentifier("settings.semanticSearch")
        .task {
            while !Task.isCancelled {
                await model.refresh()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    /// The download outlives this page, so it runs in its own task.
    private func toggle(_ isOn: Bool) {
        if isOn {
            Task { await model.turnOn() }
        } else {
            confirmingOff = true
        }
    }

    @ViewBuilder
    private func stateRow(_ row: SemanticSearchDisplay.Row) -> some View {
        switch row {
        case let .progress(title, detail, fraction):
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                SettingsRowLabel(
                    title: title, value: fraction.formatted(.percent.precision(.fractionLength(0))), detail: detail
                )
                ProgressView(value: fraction)
                    .tint(Tokens.Tint.base.color)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings.semanticSearch.progress")
        case let .failed(title, guidance):
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                SettingsRowLabel(title: title, detail: guidance)
                    .accessibilityIdentifier("settings.semanticSearch.failed")
            }
            SettingsActionRow(title: SemanticSearchCopy.retry, symbol: "arrow.clockwise",
                              identifier: "settings.semanticSearch.retry") {
                Task { await model.turnOn() }
            }
        case let .ready(indexed):
            SettingsRowLabel(title: SemanticSearchCopy.ready, symbol: "checkmark.circle")
            LabeledContent(SemanticSearchCopy.indexed, value: indexed)
                .font(Tokens.Typography.body.font)
                .accessibilityIdentifier("settings.semanticSearch.indexed")
        }
    }
}

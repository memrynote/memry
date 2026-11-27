import MemryCore
import SwiftUI

extension EnvironmentValues {
    /// The account session feedback is sent through, set once at the auth
    /// root. Signed out it sends without a bearer, which the server takes as
    /// anonymous feedback, as desktop's is.
    @Entry var feedbackSession: (any AuthSessionProtocol)?
}

/// Desktop's feedback dialog as a page: Settings › General › Send feedback,
/// About › Send feedback, and the first-sync screen's sheet.
struct FeedbackScreen: View {
    let signedIn: Bool
    var accountEmail: String?
    @Environment(\.feedbackSession) private var session
    @State private var model: FeedbackModel?

    var body: some View {
        Group {
            if let model {
                FeedbackForm(model: model, accountEmail: accountEmail)
            } else {
                List { SettingsFooter(FeedbackCopy.unavailable) }.settingsList()
            }
        }
        .navigationTitle(FeedbackCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard model == nil, let session else { return }
            model = FeedbackModel(signedIn: signedIn) { body in
                try await session.sendFeedback(payloadJson: body)
            }
        }
    }
}

private struct FeedbackForm: View {
    @Bindable var model: FeedbackModel
    let accountEmail: String?
    private enum Field { case message, email }
    @FocusState private var typing: Field?

    var body: some View {
        List {
            // First, so the result is in view above the keyboard.
            outcome
            Section {
                TextField(FeedbackCopy.placeholder, text: $model.message, axis: .vertical)
                    .lineLimit(6...14)
                    .font(Tokens.Typography.body.font)
                    .focused($typing, equals: .message)
                    .accessibilityIdentifier("feedback.message")
            } footer: {
                SettingsFooter(FeedbackCopy.description)
            }
            if !model.signedIn {
                Section {
                    TextField(FeedbackCopy.email, text: $model.replyEmail)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($typing, equals: .email)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("feedback.email")
                } footer: {
                    SettingsFooter(model.emailIsValid ? FeedbackCopy.emailHint : FeedbackCopy.emailInvalid)
                }
            }
            Section {
                SettingsToggleRow(title: FeedbackCopy.attachLogs, isOn: $model.includeLogs,
                                  identifier: "feedback.attachLogs")
                NavigationLink {
                    FeedbackLogsScreen(load: model.logsToSend)
                } label: {
                    SettingsRowLabel(title: FeedbackCopy.previewLogs, symbol: "doc.text.magnifyingglass")
                }
                .accessibilityIdentifier("feedback.previewLogs")
            } footer: {
                SettingsFooter(FeedbackCopy.logsFooter)
            }
            Section {
                bullet(FeedbackCopy.sentMessage)
                bullet(model.signedIn ? FeedbackCopy.sentEmailSignedIn(accountEmail) : FeedbackCopy.sentEmailOptional)
                bullet(FeedbackCopy.sentVersion)
                if model.signedIn { bullet(FeedbackCopy.sentPlan) }
                if model.includeLogs { bullet(FeedbackCopy.sentLogs) }
            } header: {
                Text(FeedbackCopy.whatGetsSent)
            } footer: {
                SettingsFooter(FeedbackCopy.sentNote)
            }
        }
        .settingsList()
        .onChange(of: model.message) { _, _ in model.edited() }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(model.status == .sending ? FeedbackCopy.sending : FeedbackCopy.send) {
                    typing = nil
                    Task { await model.submit() }
                }
                .disabled(!model.canSend)
                .accessibilityIdentifier("feedback.send")
            }
        }
    }

    @ViewBuilder
    private var outcome: some View {
        switch model.status {
        case .sent:
            Section {
                Label(FeedbackCopy.sent, systemImage: "checkmark.circle")
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityIdentifier("feedback.sent")
            }
        case let .failed(error):
            Section { ErrorNotice(error: error, code: nil) }
        case .editing, .sending:
            EmptyView()
        }
    }

    private func bullet(_ text: String) -> some View {
        Text(text)
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.secondary.color)
    }
}

/// Exactly the text the toggle attaches, line by line.
struct FeedbackLogsScreen: View {
    let load: @MainActor () -> String
    @State private var lines: [String]?
    @State private var bytes = 0

    var body: some View {
        Group {
            if let lines, !lines.isEmpty {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Tokens.Space.tight) {
                        SettingsFooter(FeedbackCopy.logsSize(lines: lines.count, bytes: bytes))
                            .padding(.bottom, Tokens.Space.small)
                        ForEach(lines.indices, id: \.self) { index in
                            Text(lines[index])
                                .font(Tokens.Typography.technicalCaption.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .textSelection(.enabled)
                    .padding(.horizontal, Tokens.Space.screenInline)
                    .padding(.vertical, Tokens.Space.inset)
                }
                .accessibilityIdentifier("feedback.logs")
            } else if lines != nil {
                List { SettingsFooter(FeedbackCopy.logsEmpty) }.settingsList()
            } else {
                ProgressView()
            }
        }
        .background(Tokens.Canvas.background.color)
        .navigationTitle(FeedbackCopy.logsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let text = load()
            bytes = text.utf8.count
            lines = text.split(separator: "\n").map(String.init)
        }
    }
}

/// The first-sync screen's way in: a quiet button that opens the page in a
/// sheet, for a sync that seems stuck.
struct FeedbackSheetButton: View {
    @State private var presented = false

    var body: some View {
        Button(FeedbackCopy.title) { presented = true }
            .memrySecondaryAction()
            .accessibilityIdentifier("feedback.open")
            .sheet(isPresented: $presented) {
                NavigationStack {
                    FeedbackScreen(signedIn: true)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button(FeedbackCopy.done) { presented = false }
                            }
                        }
                }
            }
    }
}

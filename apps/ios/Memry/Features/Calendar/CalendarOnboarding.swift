import MemryCore
import SwiftUI

// Spec 007 CL063 (artboards 24, 25, 26). Finishing a Google connection
// another device made, where new events go after a first connect, and the
// once-per-provider question whether the AI agent may read imported events
// (desktop `agent-access-consent-dialog.tsx`, `use-agent-access-consent.ts`,
// `google-calendar-onboarding-dialog.tsx`).

extension CalendarStore {
    /// A Google account is connected (a synced row) but this iPhone holds no
    /// tokens for it: Paper 24's "Finish connecting".
    var googleNeedsSignInHere: Bool {
        let accounts = googleAccounts.filter { $0.archivedAt == nil }
        return !accounts.isEmpty && !accounts.contains { $0.accountId.map(holdsGoogle) == true }
    }

    /// Providers whose imported calendars this vault shows and whose agent
    /// consent was never answered. EventKit is left out: its events never
    /// leave this iPhone, so the agent cannot read them.
    func unansweredConsentProviders() async -> [String] {
        let providers = Set(sources.filter { $0.kind == "calendar" && $0.isSelected && $0.archivedAt == nil && !$0.isMemryManaged }
            .map(\.provider)).subtracting(["apple-eventkit", "memry"]).sorted()
        var unanswered: [String] = []
        for provider in providers {
            let core = core
            guard let stored = await read({ try core.setting(path: "calendar.\(provider).agentReadEventsConsent") }) else { continue }
            // Only a stored answer closes the question; `null` means not asked.
            if stored == nil || stored == "null" { unanswered.append(provider) }
        }
        return unanswered
    }

    func answerConsent(_ provider: String, granted: Bool) async {
        _ = await write { try $0.setSetting(path: "calendar.\(provider).agentReadEventsConsent", valueJson: granted ? "true" : "false") }
    }

    /// Desktop opens the default picker after a connect only until it was
    /// answered once (`onboardingCompleted`).
    func googleOnboardingPending() async -> Bool {
        let core = core
        return await read { try core.setting(path: "calendar.google.onboardingCompleted") } != Optional(Optional("true"))
    }
}

/// Paper 24's pill under the header.
struct CalendarConnectPill: View {
    let action: () -> Void

    var body: some View {
        Button(CalendarCopy.connectGoogle, action: action)
            .font(Tokens.Typography.caption.font.weight(.semibold))
            .buttonStyle(.glassProminent)
            .tint(Tokens.Tint.base.color)
            .accessibilityIdentifier("calendar.connectGoogle")
    }
}

/// Paper 24: what connecting adds, Continue with Google, Not now.
struct CalendarConnectSheet: View {
    @Bindable var store: CalendarStore
    let notNow: () -> Void
    let connected: () -> Void
    @State private var connecting = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            Text(CalendarCopy.finishConnectingTitle)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text(CalendarCopy.finishConnectingBody)
                .foregroundStyle(Tokens.Text.secondary.color)
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                ForEach(CalendarCopy.connectBenefits, id: \.self) { line in
                    Label {
                        Text(line).foregroundStyle(Tokens.Text.primary.color).fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(Tokens.Calendar.green.rail.color)
                    }
                }
            }
            if let failure {
                Text(CalendarCopy.googleFailure(failure))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Interaction.destructive.color)
            }
            VStack(spacing: Tokens.Space.small) {
                Button {
                    Task { await connect() }
                } label: {
                    Text(connecting ? CalendarCopy.connecting : CalendarCopy.continueWithGoogle).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .tint(Tokens.Tint.base.color)
                .controlSize(.large)
                .disabled(connecting)
                .accessibilityIdentifier("calendar.connect.continue")
                Button {
                    notNow()
                    dismiss()
                } label: {
                    Text(CalendarCopy.notNow).frame(maxWidth: .infinity).foregroundStyle(Tokens.Text.primary.color)
                }
                .buttonStyle(.glass)
                .controlSize(.large)
                .accessibilityIdentifier("calendar.connect.notNow")
            }
            Text(CalendarCopy.connectFootnote)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .padding(Tokens.Space.inset + Tokens.Space.tight)
        .presentationDetents([.medium, .large])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.connect.sheet")
    }

    private func connect() async {
        connecting = true
        defer { connecting = false }
        failure = nil
        switch await store.connectGoogle() {
        case .connected:
            dismiss()
            connected()
        case .cancelled: break
        case let .failed(code): failure = code
        }
    }
}

/// Paper 26, asked once per provider the first time the calendar opens with
/// its calendars. Both buttons are an answer; declining stores `false` so the
/// question does not come back.
struct CalendarConsentPrompt: ViewModifier {
    @Bindable var store: CalendarStore
    @State private var queue: [String] = []
    @State private var checked: Set<String> = []

    private var providerKey: String {
        Set(store.sources.filter { $0.kind == "calendar" && $0.isSelected && $0.archivedAt == nil }.map(\.provider)).sorted().joined(separator: ",")
    }

    func body(content: Content) -> some View {
        content
            .task(id: providerKey) {
                let fresh = await store.unansweredConsentProviders().filter { !checked.contains($0) }
                checked.formUnion(fresh)
                queue.append(contentsOf: fresh)
            }
            .alert(
                CalendarCopy.consentTitle(queue.first ?? "google"),
                isPresented: Binding(get: { !queue.isEmpty }, set: { _ in })
            ) {
                Button(CalendarCopy.allow) { Task { await decide(true) } }
                    .accessibilityIdentifier("calendar.consent.allow")
                Button(CalendarCopy.dontAllow, role: .cancel) { Task { await decide(false) } }
                    .accessibilityIdentifier("calendar.consent.deny")
            } message: {
                Text(CalendarCopy.consentBody(queue.first ?? "google"))
            }
    }

    private func decide(_ granted: Bool) async {
        guard let provider = queue.first else { return }
        await store.answerConsent(provider, granted: granted)
        queue.removeFirst()
    }
}

/// Paper 25, after a first Google connect: the Google calendar memrynote uses
/// by default. Use and Skip both finish onboarding, as desktop's dialog does.
struct CalendarDefaultPickerSheet: View {
    @Bindable var store: CalendarStore
    @State private var selection: String?
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    private var calendars: [CalendarSourceRecord] {
        store.sources.filter { $0.kind == "calendar" && $0.provider == "google" && $0.archivedAt == nil }
            .sorted { ($0.isMemryManaged ? 0 : 1, $0.isPrimary ? 1 : 2, $0.title) < ($1.isMemryManaged ? 0 : 1, $1.isPrimary ? 1 : 2, $1.title) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            Text(CalendarCopy.pickDefaultTitle)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text(CalendarCopy.pickDefaultBody)
                .foregroundStyle(Tokens.Text.secondary.color)
            VStack(spacing: 0) {
                ForEach(Array(calendars.enumerated()), id: \.element.id) { index, source in
                    if index > 0 { Divider().padding(.leading, Tokens.Space.inset) }
                    row(source)
                }
            }
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
            VStack(spacing: Tokens.Space.small) {
                Button {
                    Task { await finish(use: true) }
                } label: {
                    Text(CalendarCopy.useCalendar).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .tint(Tokens.Tint.base.color)
                .controlSize(.large)
                .disabled(saving)
                .accessibilityIdentifier("calendar.default.use")
                Button {
                    Task { await finish(use: false) }
                } label: {
                    Text(CalendarCopy.skip).frame(maxWidth: .infinity).foregroundStyle(Tokens.Text.primary.color)
                }
                .buttonStyle(.glass)
                .controlSize(.large)
                .disabled(saving)
                .accessibilityIdentifier("calendar.default.skip")
            }
        }
        .padding(Tokens.Space.inset + Tokens.Space.tight)
        .presentationDetents([.medium, .large])
        .onAppear { selection = calendars.first(where: \.isPrimary)?.id ?? calendars.first?.id }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.default.sheet")
    }

    private func row(_ source: CalendarSourceRecord) -> some View {
        Button { selection = source.id } label: {
            HStack(spacing: Tokens.Space.medium) {
                Circle()
                    .fill(source.color.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color } ?? Tokens.Tint.base.color)
                    .frame(width: 8, height: 8)
                Text(source.isMemryManaged ? CalendarCopy.memryManagedCalendar : source.title)
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer()
                if selection == source.id {
                    Image(systemName: "checkmark").foregroundStyle(Tokens.Text.tint.color)
                } else if source.isMemryManaged || source.isPrimary {
                    Text(source.isMemryManaged ? CalendarCopy.managed : CalendarCopy.primary)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            .padding(.horizontal, Tokens.Space.inset)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == source.id ? .isSelected : [])
    }

    private func finish(use: Bool) async {
        saving = true
        if use, let source = calendars.first(where: { $0.id == selection }) {
            // The managed calendar is Google's own default: no explicit target.
            await store.setDefaultTarget(source.isMemryManaged ? nil : source)
        }
        _ = await store.write { try $0.setSetting(path: "calendar.google.onboardingCompleted", valueJson: "true") }
        saving = false
        dismiss()
    }
}

extension CalendarCopy {
    static let connectGoogle = "Connect Google"
    static let finishConnectingTitle = "Finish connecting to Google Calendar"
    static let finishConnectingBody = "Connect your Google account to do more with your calendar:"
    static let connectBenefits = [
        "See your Google events beside notes and tasks",
        "Create and edit events, synced both ways",
        "Schedule tasks and notes on your calendar"
    ]
    static let continueWithGoogle = "Continue with Google"
    static let connecting = "Connecting…"
    static let notNow = "Not now"
    static let connectFootnote = "Opens Google sign-in in a secure browser sheet and returns here."
    static let pickDefaultBody = "Pick the Google calendar memrynote uses by default. You can still change it per event."
    static let memryManagedCalendar = "memrynote calendar"
    static let managed = "managed"
    static let primary = "primary"
    static let allow = "Allow"
    static let dontAllow = "Don't allow"

    private static func providerName(_ provider: String) -> String {
        switch provider {
        case "ics": "subscribed calendar"
        case "caldav": "CalDAV calendar"
        default: provider
        }
    }

    static func consentTitle(_ provider: String) -> String {
        provider == "google" ? "Let AI read your Google Calendar events?" : "Let AI read your \(providerName(provider)) events?"
    }

    static func consentBody(_ provider: String) -> String {
        let body = provider == "google"
            ? "You keep seeing your Google events in memrynote either way. This only decides whether the AI agent can read them when you ask about your schedule."
            : "You keep seeing these events in memrynote either way. This only decides whether the AI agent can read them when you ask about your schedule."
        return body + "\n\nEach calendar service gets its own answer. Change it any time in Settings › Calendar."
    }
}

import MemryCore
import SwiftUI

// Spec 007 CL062/CL073 (artboard 29). Subscribed calendars: paste a link,
// the http warning, Subscribe, help, and the subscriptions with their state on
// this iPhone. Each row's … holds Rename, Color, Refresh and Remove; a swipe
// removes. The subscription syncs; the events are fetched on each device.

struct CalendarFeedsScreen: View {
    @Bindable var store: CalendarStore
    @State private var link = ""
    @State private var subscribing = false
    @State private var error: String?
    @State private var states: [String: CalendarFeedState] = [:]
    @State private var renaming: CalendarSourceRecord?
    @State private var newName = ""
    @State private var showsHelp = false
    @FocusState private var linkFocused: Bool

    private var feeds: [CalendarSourceRecord] {
        store.sources.filter { $0.provider == "ics" && $0.archivedAt == nil }
    }

    private var isPlainHttp: Bool {
        link.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("http://")
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                    Text(CalendarCopy.feedsIntro)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                    TextField(CalendarCopy.feedPlaceholder, text: $link)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.go)
                        .focused($linkFocused)
                        .onSubmit { Task { await subscribe() } }
                        .padding(.horizontal, Tokens.Space.medium)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .background(Tokens.Canvas.surface.color, in: RoundedRectangle(cornerRadius: Tokens.Radius.container))
                        .overlay {
                            RoundedRectangle(cornerRadius: Tokens.Radius.container)
                                .strokeBorder(linkFocused ? Tokens.Tint.base.color : Tokens.Line.border.color)
                        }
                        .accessibilityIdentifier("calendar.feeds.link")
                    if isPlainHttp {
                        Text(CalendarCopy.feedHttpWarning)
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Task.dueToday.color)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(Tokens.Space.medium)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Tokens.Task.dueToday.color.opacity(0.12), in: RoundedRectangle(cornerRadius: Tokens.Radius.container))
                            .accessibilityIdentifier("calendar.feeds.httpWarning")
                    }
                    if let error {
                        Text(CalendarCopy.feedError(error))
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Interaction.destructive.color)
                            .accessibilityIdentifier("calendar.feeds.error")
                    }
                    Button { Task { await subscribe() } } label: {
                        Group {
                            if subscribing { ProgressView() } else { Text(CalendarCopy.subscribe) }
                        }
                        .font(Tokens.Typography.body.font.weight(.semibold))
                        .foregroundStyle(Tokens.Tint.foreground.color)
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Tokens.Tint.base.color)
                    .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty || subscribing)
                    .accessibilityIdentifier("calendar.feeds.subscribe")
                    DisclosureGroup(isExpanded: $showsHelp) {
                        Text(CalendarCopy.feedHelp)
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                    } label: {
                        Text(CalendarCopy.feedWhereLink)
                            .font(Tokens.Typography.supporting.font.weight(.semibold))
                            .foregroundStyle(Tokens.Text.tint.color)
                    }
                    .tint(Tokens.Text.tint.color)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: Tokens.Space.inset, bottom: 0, trailing: Tokens.Space.inset))
            }
            if !feeds.isEmpty {
                Section {
                    ForEach(feeds, id: \.id) { feed in row(feed) }
                } header: {
                    Text(CalendarCopy.subscribedHeader)
                } footer: {
                    Text(CalendarCopy.feedsFooter)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.background.color)
        .navigationTitle(CalendarCopy.subscribedTitle)
        .navigationBarTitleDisplayMode(.large)
        .refreshable {
            await store.refreshFeeds(force: true)
            await loadStates()
        }
        .task { await loadStates() }
        .alert(CalendarCopy.renameCalendar, isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(CalendarCopy.calendarName, text: $newName)
            Button(CalendarCopy.save) {
                if let feed = renaming { Task { await store.renameFeed(feed.id, title: newName, color: nil) } }
            }
            Button(CalendarCopy.cancel, role: .cancel) {}
        }
    }

    private func row(_ feed: CalendarSourceRecord) -> some View {
        let state = states[feed.id]
        let failed = state?.syncStatus == "error"
        return HStack(spacing: Tokens.Space.medium) {
            Circle()
                .fill(feed.color.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color } ?? Tokens.Calendar.violet.rail.color)
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text(feed.title).foregroundStyle(Tokens.Text.primary.color)
                Text(status(state))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(failed ? Tokens.Interaction.destructive.color : Tokens.Text.secondary.color)
            }
            Spacer()
            Menu {
                Button(CalendarCopy.rename, systemImage: "pencil") {
                    newName = feed.title
                    renaming = feed
                }
                Menu(CalendarCopy.color) {
                    ForEach(Tokens.Calendar.eventColors, id: \.name) { color in
                        Button(CalendarCopy.colorName(color.name)) {
                            Task { await store.renameFeed(feed.id, title: nil, color: color.name) }
                        }
                    }
                }
                Button(CalendarCopy.refresh, systemImage: "arrow.clockwise") {
                    Task {
                        await store.refreshFeeds(force: true)
                        await loadStates()
                    }
                }
                Button(CalendarCopy.remove, systemImage: "trash", role: .destructive) {
                    Task { await store.unsubscribeFeed(feed.id); await loadStates() }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
            }
            .accessibilityLabel(CalendarCopy.moreActions)
            .accessibilityIdentifier("calendar.feeds.more.\(feed.id)")
        }
        .swipeActions {
            Button(CalendarCopy.remove, role: .destructive) {
                Task { await store.unsubscribeFeed(feed.id); await loadStates() }
            }
        }
        .accessibilityIdentifier("calendar.feeds.row.\(feed.id)")
    }

    private func status(_ state: CalendarFeedState?) -> String {
        guard let state else { return CalendarCopy.notSyncedYet }
        if state.syncStatus == "error", let code = state.lastError {
            return CalendarCopy.feedFailed(code)
        }
        guard let last = state.lastSyncedAt.flatMap(CalendarDates.date) else { return CalendarCopy.notSyncedYet }
        return "\(CalendarCopy.updated(last.formatted(.relative(presentation: .named)))) · \(CalendarCopy.eventCount(Int(state.eventCount))) · \(CalendarCopy.readOnly)"
    }

    private func loadStates() async {
        states = Dictionary(uniqueKeysWithValues: await store.feedStates().map { ($0.sourceId, $0) })
    }

    private func subscribe() async {
        guard !subscribing else { return }
        subscribing = true
        defer { subscribing = false }
        error = nil
        if let code = await store.subscribeFeed(link, title: nil) {
            error = code
        } else {
            link = ""
            linkFocused = false
            await loadStates()
        }
    }
}

extension CalendarCopy {
    static let subscribedTitle = "Subscribed"
    static let feedsIntro = "Add a read-only calendar by its shared link (ICS or webcal), like Proton, iCloud, Outlook or Fastmail. Checked about once an hour."
    static let feedPlaceholder = "https:// or webcal:// link"
    static let feedHttpWarning = "Not encrypted. This link starts with http://, so anyone on the same network can read it. Use https:// or webcal:// if offered."
    static let subscribe = "Subscribe"
    static let feedWhereLink = "Where do I find the link?"
    static let feedHelp = "Proton: Settings › Calendars › Share › Share with anyone. iCloud: Calendar › Share › Public calendar. Outlook: Settings › Calendar › Shared calendars › Publish. Fastmail: Settings › Calendars › Sharing › Publish. Copy the ICS or webcal link."
    static let subscribedHeader = "Subscribed"
    static let feedsFooter = "… per calendar: Rename, Color, Refresh, Remove. Swipe left to remove."
    static let renameCalendar = "Rename calendar"
    static let calendarName = "Name"
    static let rename = "Rename"
    static let refresh = "Refresh"
    static let remove = "Remove"
    static func eventCount(_ count: Int) -> String { count == 1 ? "1 event" : "\(count) events" }
    /// Paper 29: the reason, then that the old events stay.
    static func feedFailed(_ code: String) -> String {
        "\(feedError(code)) Events stay until the next update."
    }
}

import MemryCore
import SwiftUI

// IB10 / IB11 / IB12 / IB19. The pushed detail (Paper 10-12): the kind and
// capture time, the title (editable for voice, image and PDF, desktop's
// rule), the per-type body, and a bottom glass bar with Archive, Convert
// (hidden for note-only types) and the primary "File…" (no suggestion to
// name, D5). An archived capture is read-only with Restore and Delete
// permanently (Paper 19). Opening a reminder capture marks it viewed.

struct InboxDetailView: View {
    let itemId: String
    let store: InboxStore

    @Environment(\.dismiss) private var dismiss
    @State private var item: InboxItemRecord?
    @State private var loaded = false
    @State private var title = ""
    @State private var sheets = InboxSheets()
    @State private var confirmingDelete = false
    @FocusState private var titleFocused: Bool

    private var isArchived: Bool { item?.archivedAtMs != nil }
    private var isFiled: Bool { item?.filedAtMs != nil }
    private var editableTitle: Bool { ["voice", "image", "pdf"].contains(item?.itemType ?? "") && !isArchived }

    var body: some View {
        Group {
            if let item {
                ScrollView {
                    VStack(alignment: .leading, spacing: Tokens.Space.inset) {
                        header(item)
                        InboxDetailContent(item: item, store: store, editable: !isArchived && !isFiled)
                    }
                    .padding(.horizontal, InboxLayout.edge)
                    .padding(.bottom, Tokens.Space.screenBlock * 3)
                }
                .scrollDismissesKeyboard(.interactively)
                .safeAreaInset(edge: .bottom) { bottomBar(item) }
            } else if loaded {
                ContentUnavailableView(InboxCopy.itemGone, systemImage: "tray", description: Text(InboxCopy.itemGoneDetail))
            } else {
                ProgressView()
            }
        }
        .background(Tokens.Canvas.background.color)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if let item, !isArchived, !isFiled { ToolbarItem(placement: .topBarTrailing) { menu(item) } } }
        .toolbar(.hidden, for: .tabBar)
        .inboxSheets($sheets, store: store) { dismiss() }
        .confirmationDialog(InboxCopy.deleteTitle, isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(InboxCopy.deletePermanently, role: .destructive) {
                guard let item else { return }
                Task {
                    await store.deletePermanently(item)
                    dismiss()
                }
            }
        } message: {
            Text(InboxCopy.deleteBody)
        }
        .task(id: itemId) { await load() }
        .onChange(of: store.items) { _, _ in Task { await reload() } }
    }

    private func header(_ item: InboxItemRecord) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack(spacing: Tokens.Space.tight + 2) {
                Image(systemName: InboxTypeGlyph.symbol(item.itemType))
                    .foregroundStyle(Tokens.Inbox.type(item.itemType).color)
                    .accessibilityHidden(true)
                Text(InboxCopy.detailKind(InboxCopy.kindName(item.itemType), InboxDetailFormat.captured(item.createdAtMs, now: store.clock())))
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            .font(Tokens.Typography.caption.font)
            if editableTitle {
                TextField(item.itemType == "voice" ? InboxCopy.voiceTitlePlaceholder : InboxCopy.titlePlaceholder,
                          text: $title, axis: .vertical)
                    .font(Tokens.Typography.screenTitle.font.weight(.bold))
                    .foregroundStyle(Tokens.Text.primary.color)
                    .focused($titleFocused)
                    .submitLabel(.done)
                    .onSubmit(saveTitle)
                    .onChange(of: titleFocused) { _, focused in if !focused { saveTitle() } }
                    .accessibilityIdentifier("inbox.detail.title")
            } else {
                Text(InboxMeta.displayTitle(item))
                    .font(Tokens.Typography.screenTitle.font.weight(.bold))
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("inbox.detail.title")
            }
        }
        .padding(.top, Tokens.Space.small)
    }

    @ViewBuilder
    private func bottomBar(_ item: InboxItemRecord) -> some View {
        if isFiled {
            EmptyView()
        } else if isArchived {
            HStack(spacing: Tokens.Space.small) {
                barButton(InboxCopy.deletePermanently, "trash", role: .destructive) { confirmingDelete = true }
                    .accessibilityIdentifier("inbox.detail.delete")
                primaryButton(InboxCopy.restore, "arrow.uturn.backward") {
                    Task {
                        await store.restore(item)
                        dismiss()
                    }
                }
                .accessibilityIdentifier("inbox.detail.restore")
            }
            .padding(Tokens.Space.tight)
            .chromeGlass(in: .capsule)
            .padding(.horizontal, InboxLayout.edge)
        } else {
            HStack(spacing: Tokens.Space.small) {
                barButton(InboxCopy.archive, "archivebox") {
                    Task {
                        await store.archive(item)
                        dismiss()
                    }
                }
                .accessibilityIdentifier("inbox.detail.archive")
                if !item.isNoteOnly {
                    barButton(InboxCopy.convert, "arrow.left.arrow.right") { sheets.convert = item }
                        .accessibilityIdentifier("inbox.detail.convert")
                }
                primaryButton(InboxCopy.fileEllipsis, "folder") { sheets.file = InboxFileRequest(ids: [item.id]) }
                    .accessibilityIdentifier("inbox.detail.file")
            }
            .padding(Tokens.Space.tight)
            .chromeGlass(in: .capsule)
            .padding(.horizontal, InboxLayout.edge)
        }
    }

    private func barButton(_ label: String, _ symbol: String, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role, action: action) {
            VStack(spacing: 2) {
                Image(systemName: symbol).font(Tokens.Typography.body.font)
                Text(label).font(Tokens.Typography.caption.font)
            }
            .foregroundStyle(role == .destructive ? Tokens.Interaction.destructive.color : Tokens.Text.primary.color)
            .frame(minWidth: Tokens.Size.minimumHitArea + Tokens.Space.inset, minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func primaryButton(_ label: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: symbol)
                .font(Tokens.Typography.body.font.weight(.semibold))
                .foregroundStyle(Tokens.Tint.foreground.color)
                .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea + Tokens.Space.tight)
        }
        .buttonStyle(.glassProminent)
        .tint(Tokens.Tint.base.color)
    }

    private func menu(_ item: InboxItemRecord) -> some View {
        Menu {
            Menu {
                InboxSnoozeMenuItems(now: store.clock()) { date in
                    Task {
                        await store.snooze([item.id], until: date)
                        dismiss()
                    }
                } pickDate: {
                    sheets.snoozeIds = [item.id]
                }
            } label: {
                Label(InboxCopy.snooze, systemImage: "moon.zzz")
            }
            if let link = item.sourceUrl, let url = URL(string: link) {
                Link(destination: url) { Label(InboxCopy.openLink, systemImage: "safari") }
            }
            if item.itemType != "note", item.itemType != "reminder", !editableTitle {
                Button(InboxCopy.rename, systemImage: "pencil") { sheets.rename = item }
            }
        } label: {
            Image(systemName: "ellipsis").accessibilityLabel(InboxCopy.more)
        }
        .accessibilityIdentifier("inbox.detail.more")
    }

    private func load() async {
        await reload()
        loaded = true
        if let item, item.itemType == "reminder", item.viewedAtMs == nil { await store.markViewed(item.id) }
    }

    private func reload() async {
        let fresh = await store.fetch(itemId)
        item = fresh
        if !titleFocused { title = fresh?.title ?? "" }
    }

    private func saveTitle() {
        guard let item, title != item.title else { return }
        Task { await store.rename(item.id, to: title) }
    }
}

enum InboxDetailFormat {
    /// `content.capturedAt` with `todayAt` / `yesterdayAt` / `dateAt`.
    static func captured(_ ms: Int64, now: Date, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let time = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        if calendar.isDate(date, inSameDayAs: now) { return "today at \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "yesterday at \(time)"
        }
        return "\(date.formatted(.dateTime.month(.abbreviated).day())) at \(time)"
    }
}

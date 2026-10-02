import MemryCore
import SwiftUI

// The Notes root's Bookmarks and Tags, under Collections (the folder tree):
// the phone's form of the desktop sidebar's sections.
//
// **Bookmarks are desktop's, read only.** The core resolves each one the way
// desktop's sidebar does and drops the ones whose item is gone, so every row
// here opens something. A note, folder or tag pushes onto the Notes stack; a
// journal day and a task open in their own tabs.
//
// **Tags are chips, most used first**, in the colour desktop draws them. A
// tap pushes the tag's notes, which is desktop's folder view scoped to a tag.
//
// **Ten of each on the root**, then a row to a page holding all of them with
// a search field. Each section folds away, as desktop's sidebar sections
// do; which ones are folded is this device's choice, never synced.
//
// **Titles are rows, not `Section` headers**: a plain list paints a header
// its own sticky band, which drew as a dark stripe over the canvas.

/// A route to every bookmark, from the root's Bookmarks section.
struct BookmarkListRoute: Hashable, Codable, Sendable {}

/// How many bookmarks and tags the root shows before "Show all".
enum NotesShortcutsLimit {
    static let root = 10
}

extension View {
    /// A Notes-root row on the canvas: no system fill, no separator.
    func shortcutRow() -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: Tokens.Space.small, bottom: 0, trailing: Tokens.Space.small))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

/// A section title on the Notes root, as desktop's sidebar labels its own.
/// A tap folds the section away and back, as desktop's does; the chevron
/// says which way it is.
struct ShortcutsTitleRow: View {
    let title: String
    @Binding var isCollapsed: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            withAnimation(reduceMotion ? nil : .snappy) { isCollapsed.toggle() }
        } label: {
            HStack(spacing: Tokens.Space.tight) {
                Text(title)
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.secondary.color)
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
            }
            .padding(.top, Tokens.Space.medium)
            .padding(.horizontal, Tokens.Space.small)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")
        .accessibilityHint(isCollapsed ? "Shows this section." : "Hides this section.")
        .shortcutRow()
    }
}

/// The "Show all" row under a capped section.
private struct ShowAllRow<Route: Hashable>: View {
    let title: String
    let route: Route

    var body: some View {
        NavigationLink(value: route) {
            HStack(spacing: Tokens.Space.small) {
                Text(title)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            .padding(.horizontal, Tokens.Space.small)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .contentShape(.rect)
        }
        .navigationLinkIndicatorVisibility(.hidden)
        .shortcutRow()
    }
}

/// The root's Bookmarks: a title, the first ten, and "Show all".
struct BookmarksSection: View {
    let bookmarks: [BookmarkEntry]
    @AppStorage("notes.section.bookmarks.collapsed") private var isCollapsed = false

    var body: some View {
        if !bookmarks.isEmpty {
            ShortcutsTitleRow(title: "Bookmarks", isCollapsed: $isCollapsed)
        }
        if !bookmarks.isEmpty, !isCollapsed {
            ForEach(bookmarks.prefix(NotesShortcutsLimit.root), id: \.id) { bookmark in
                BookmarkRow(bookmark: bookmark)
            }
            if bookmarks.count > NotesShortcutsLimit.root {
                ShowAllRow(title: "Show all \(bookmarks.count) bookmarks", route: BookmarkListRoute())
            }
        }
    }
}

/// The root's Tags: a title, the ten most used as chips, and "Show all".
struct TagsSection: View {
    let tags: [TagSummary]
    let openTag: (String) -> Void
    @AppStorage("notes.section.tags.collapsed") private var isCollapsed = false

    var body: some View {
        if !tags.isEmpty {
            ShortcutsTitleRow(title: "Tags", isCollapsed: $isCollapsed)
        }
        if !tags.isEmpty, !isCollapsed {
            FlowLayout(spacing: Tokens.Space.small) {
                ForEach(tags.prefix(NotesShortcutsLimit.root), id: \.name) { tag in
                    // Borderless: several buttons in one list row each keep
                    // their own tap.
                    Button { openTag(tag.name) } label: {
                        Chip(text: tag.name, color: Tokens.Palette.color(tag.color, tag: tag.name), symbol: "#")
                            .frame(minHeight: Tokens.Size.minimumHitArea)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("\(tag.name), \(tag.noteCount) \(tag.noteCount == 1 ? "note" : "notes")")
                }
            }
            .padding(.horizontal, Tokens.Space.small)
            .shortcutRow()
            if tags.count > NotesShortcutsLimit.root {
                ShowAllRow(title: "Show all \(tags.count) tags", route: TagListRoute())
            }
        }
    }
}

/// One bookmark row, on the root and on the Bookmarks page.
struct BookmarkRow: View {
    let bookmark: BookmarkEntry

    @Environment(\.openJournalDay) private var openJournalDay
    @Environment(TasksRouter.self) private var tasks: TasksRouter?

    var body: some View {
        Group {
            switch bookmark.itemType {
            case "note":
                NavigationLink(value: NoteRoute(id: bookmark.itemId)) { label }
                    .navigationLinkIndicatorVisibility(.hidden)
            case "folder":
                NavigationLink(value: FolderRoute(path: bookmark.itemId)) { label }
                    .navigationLinkIndicatorVisibility(.hidden)
            case "tag":
                NavigationLink(value: TagRoute(name: bookmark.itemId)) { label }
                    .navigationLinkIndicatorVisibility(.hidden)
            case "journal":
                Button { if let date = bookmark.journalDate { openJournalDay?(date) } } label: { label }
                    .buttonStyle(.plain)
            default:
                Button { tasks?.openTask(bookmark.itemId) } label: { label }
                    .buttonStyle(.plain)
            }
        }
        .shortcutRow()
    }

    private var label: some View {
        let title = Self.title(of: bookmark)
        return TreeRowLabel(
            depth: 0,
            disclosure: nil,
            emoji: ProjectIconValue.emoji(bookmark.emoji),
            symbol: Self.symbol(for: bookmark.itemType),
            symbolTint: Tokens.Text.tertiary.color,
            title: title.isEmpty ? "Untitled" : title,
            isPlaceholderTitle: title.isEmpty,
            isEmphasized: false
        ) { EmptyView() }
        .contentShape(.rect)
    }

    /// A journal day is named by its date, as the Journal tab names it.
    static func title(of bookmark: BookmarkEntry) -> String {
        if let date = bookmark.journalDate {
            let parser = DateFormatter()
            parser.calendar = Calendar(identifier: .gregorian)
            parser.locale = Locale(identifier: "en_US_POSIX")
            parser.dateFormat = "yyyy-MM-dd"
            return parser.date(from: date)?.formatted(date: .long, time: .omitted) ?? date
        }
        if bookmark.itemType == "tag" { return "#" + (bookmark.title ?? bookmark.itemId) }
        return bookmark.title ?? ""
    }

    /// Desktop's `bookmarkIcon`, in SF Symbols.
    static func symbol(for itemType: String) -> String {
        switch itemType {
        case "journal": "calendar"
        case "task": "checkmark.square"
        case "folder": "folder"
        case "tag": "number"
        default: "doc"
        }
    }
}

/// Every bookmark, with a search field over their titles.
struct BookmarkListView: View {
    let browse: VaultBrowseViewModel
    @State private var query = ""

    private var filtered: [BookmarkEntry] {
        guard !query.isEmpty else { return browse.bookmarks }
        return browse.bookmarks.filter { BookmarkRow.title(of: $0).localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        Group {
            if browse.bookmarks.isEmpty {
                ContentUnavailableView {
                    Label("No bookmarks", systemImage: "bookmark")
                } description: {
                    Text("Bookmarks you make on desktop show here.")
                }
            } else if filtered.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                List {
                    ForEach(filtered, id: \.id) { BookmarkRow(bookmark: $0) }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search bookmarks")
        .navigationTitle("Bookmarks")
        .background(Tokens.Canvas.background.color)
        .task { await browse.refresh() }
    }
}

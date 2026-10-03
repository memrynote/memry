import Foundation
import MemryCore

// Desktop's view block (#2488) is a `codeBlock` whose language is
// `memry-view` and whose text is a JSON definition
// (`packages/shared/src/view-block.ts`). This build draws the rows for the
// definitions it can answer from the local index and shows every other one
// as the code it is. It never writes the fence: the bytes belong to whichever
// build wrote them, and a newer one may carry keys this one cannot read.

/// What a `memry-view` fence becomes on this device.
enum ViewBlockFence: Equatable {
    case rows(ViewBlockQuery)
    /// A definition this build cannot answer in full: broken JSON, no source,
    /// a journal source, a saved view, filters, a chart, or any key or value
    /// desktop's parser knows and this one does not. Showing rows for part of
    /// it would list notes desktop does not.
    case code

    static let language = "memry-view"

    private static let answeredKeys: Set<String> = ["source", "layout", "order", "limit"]
    private static let listLayouts: Set<String> = ["list", "table", "grid"]

    init(text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(json.keys).isSubset(of: Self.answeredKeys),
              let source = ViewBlockQuery.Source(json: json["source"])
        else {
            self = .code
            return
        }
        var query = ViewBlockQuery(source: source)
        if let layout = json["layout"] {
            guard let name = layout as? String, Self.listLayouts.contains(name) else {
                self = .code
                return
            }
        }
        if let order = json["order"] {
            guard let entries = order as? [Any] else {
                self = .code
                return
            }
            var parsed: [ViewBlockQuery.Order] = []
            for entry in entries {
                guard let order = ViewBlockQuery.Order(json: entry) else {
                    self = .code
                    return
                }
                parsed.append(order)
            }
            query.order = parsed
        }
        if let limit = json["limit"] {
            guard let number = limit as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue > 0, number.doubleValue.rounded() == number.doubleValue,
                  number.doubleValue <= Double(Int.max)
            else {
                self = .code
                return
            }
            query.limit = number.intValue
        }
        self = .rows(query)
    }
}

/// The part of a view definition this build answers: where the rows come
/// from, their order and how many.
struct ViewBlockQuery: Equatable, Hashable {
    enum Source: Equatable, Hashable {
        /// Every note outside the journal.
        case vault
        /// The notes in a folder and its subfolders. `""` is the vault root.
        case folder(String)
        /// The notes and tasks carrying a tag or one of its `/` descendants,
        /// narrowed to those that also carry every `andTags` entry.
        case tag(String, andTags: [String])

        init?(json: Any?) {
            guard let json = json as? [String: Any], let kind = json["kind"] as? String else { return nil }
            let keys = Set(json.keys)
            switch kind {
            case "vault" where keys == ["kind"]:
                self = .vault
            case "folder" where keys == ["kind", "path"]:
                guard let path = json["path"] as? String else { return nil }
                self = .folder(path)
            case "tag" where keys.isSubset(of: ["kind", "tag", "andTags"]):
                guard let tag = json["tag"] as? String, !tag.isBlankText else { return nil }
                var andTags: [String] = []
                if let raw = json["andTags"] {
                    guard let list = raw as? [Any] else { return nil }
                    for value in list {
                        guard let name = value as? String, !name.isBlankText else { return nil }
                        andTags.append(name)
                    }
                }
                self = .tag(tag, andTags: andTags)
            default:
                return nil
            }
        }
    }

    /// The fields a row from the local index carries. Desktop also sorts by
    /// tags, word count and note properties; a fence ordered by those draws
    /// as code.
    enum SortKey: String, Hashable {
        case title, created, modified
    }

    struct Order: Equatable, Hashable {
        let key: SortKey
        let descending: Bool

        init(key: SortKey, descending: Bool) {
            self.key = key
            self.descending = descending
        }

        init?(json: Any) {
            guard let json = json as? [String: Any],
                  let property = json["property"] as? String, let key = SortKey(rawValue: property),
                  let direction = json["direction"] as? String, direction == "asc" || direction == "desc"
            else { return nil }
            self.init(key: key, descending: direction == "desc")
        }
    }

    var source: Source
    var order: [Order] = []
    var limit: Int?

    /// Every tag a candidate note must be read for: the source tag and each
    /// ANDed one, normalized as desktop's `listTagItems` normalizes them.
    var tagNeedles: [String] {
        guard case let .tag(tag, andTags) = source else { return [] }
        return ([tag] + andTags).map { $0.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) }
    }
}

struct ViewBlockRow: Identifiable, Equatable {
    enum Kind: Equatable {
        case note
        case task(done: Bool)
    }

    let id: String
    let kind: Kind
    let title: String
    let emoji: String?
    let created: Date?
    let modified: Date?

    /// The note a tap opens, by id: titles repeat and can be empty. `nil` for
    /// a task row.
    var noteRoute: NoteRoute? {
        kind == .note ? NoteRoute(id: id) : nil
    }
}

extension ViewBlockRow {
    init(note: NoteSummary) {
        self.init(
            id: note.id,
            kind: .note,
            title: note.title,
            emoji: note.emoji,
            created: note.createdAt.map { Date(timeIntervalSince1970: Double($0) / 1000) },
            modified: note.modifiedAt.map { Date(timeIntervalSince1970: Double($0) / 1000) }
        )
    }

    init(task: TaskItem) {
        self.init(
            id: task.id,
            kind: .task(done: task.completedAt != nil),
            title: task.title,
            emoji: nil,
            created: task.createdAt.flatMap(Self.instant),
            modified: task.modifiedAt.flatMap(Self.instant)
        )
    }

    private static func instant(_ text: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text))
            ?? (try? Date.ISO8601FormatStyle().parse(text))
    }
}

private extension String {
    var isBlankText: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

extension ViewBlockQuery {
    /// - Parameters:
    ///   - notes: every live note for a vault or folder source; for a tag
    ///     source, the notes carrying any tag in ``tagNeedles``' families.
    ///   - noteTags: for a tag source, the tags each of those notes carries.
    ///   - tasks: every live task. Only a tag source lists tasks, as on
    ///     desktop, where folders hold notes and tags hold notes and tasks.
    func rows(notes: [NoteSummary], noteTags: [String: [String]], tasks: [TaskItem]) -> [ViewBlockRow] {
        var rows: [ViewBlockRow]
        switch source {
        case .vault:
            rows = notes.map(ViewBlockRow.init(note:))
        case let .folder(path):
            rows = notes.filter { Self.isInFolder($0.folderPath, path) }.map(ViewBlockRow.init(note:))
        case .tag:
            let needles = tagNeedles
            let carries: ([String]) -> Bool = { tags in needles.allSatisfy { Self.tags(tags, match: $0) } }
            rows = notes.filter { carries(noteTags[$0.id] ?? []) }.map(ViewBlockRow.init(note:))
                + tasks.filter { carries($0.tags) }.map(ViewBlockRow.init(task:))
        }
        rows = sorted(rows)
        if let limit, rows.count > limit { rows = Array(rows.prefix(limit)) }
        return rows
    }

    /// Desktop's `itemTagsMatch`: the tag itself or a `/` descendant, never
    /// a mere prefix (`work` matches `work/meetings`, not `workshop`).
    static func tags(_ tags: [String], match needle: String) -> Bool {
        tags.contains { raw in
            let tag = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            return tag == needle || tag.hasPrefix(needle + "/")
        }
    }

    /// Desktop asks the disk. This device knows a folder only as a configured
    /// one or a note's path, as its own folder list does, so an empty folder
    /// nobody configured reads as missing here.
    static func folderExists(_ path: String, configured: [FolderSummary], notes: [NoteSummary]) -> Bool {
        configured.contains { $0.path == path } || notes.contains { isInFolder($0.folderPath, path) }
    }

    /// Desktop matches `path LIKE '<folder>/%'`, so a folder holds its
    /// subfolders' notes and the root holds every note.
    private static func isInFolder(_ folderPath: String?, _ path: String) -> Bool {
        guard !path.isEmpty else { return true }
        guard let folderPath else { return false }
        return folderPath == path || folderPath.hasPrefix(path + "/")
    }

    /// Desktop's `sortNotes`: the first key that tells two rows apart
    /// decides, and an empty value sorts last in either direction. With no
    /// order a folder or the vault lists by `modified` ascending, as desktop's
    /// folder query does, and a tag keeps the order its rows were read in,
    /// notes before tasks.
    private func sorted(_ rows: [ViewBlockRow]) -> [ViewBlockRow] {
        var order = order
        if order.isEmpty {
            if case .tag = source { return rows }
            order = [Order(key: .modified, descending: false)]
        }
        return rows.enumerated().sorted { lhs, rhs in
            for entry in order {
                switch (lhs.element.sortValue(entry.key), rhs.element.sortValue(entry.key)) {
                case (nil, nil):
                    continue
                case (nil, _):
                    return false
                case (_, nil):
                    return true
                case let (left?, right?):
                    let result = left.compare(right)
                    if result == .orderedSame { continue }
                    return (result == .orderedAscending) != entry.descending
                }
            }
            return lhs.offset < rhs.offset
        }
        .map(\.element)
    }
}

private enum SortValue {
    case text(String)
    case date(Date)

    func compare(_ other: SortValue) -> ComparisonResult {
        switch (self, other) {
        case let (.text(left), .text(right)):
            left.compare(right, options: [.numeric, .caseInsensitive, .diacriticInsensitive])
        case let (.date(left), .date(right)):
            left.compare(right)
        default:
            .orderedSame
        }
    }
}

private extension ViewBlockRow {
    func sortValue(_ key: ViewBlockQuery.SortKey) -> SortValue? {
        switch key {
        case .title: title.isEmpty ? nil : .text(title)
        case .created: created.map(SortValue.date)
        case .modified: modified.map(SortValue.date)
        }
    }
}

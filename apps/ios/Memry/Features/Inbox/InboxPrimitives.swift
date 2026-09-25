import MemryCore
import SwiftUI

// IB032. The pieces every inbox row and detail builds with (Paper "Inbox iOS"
// 01, 00 audit row "List"): the type glyph, the one meta line, the age, the
// Today / Yesterday / Older grouping. The formatting is plain functions over
// `InboxItemRecord` so a unit test can assert what a row says.

/// The SF Symbol for a capture type (desktop `InboxTypeIcon`'s lucide set).
enum InboxTypeGlyph {
    static func symbol(_ type: String) -> String {
        switch type {
        case "link": "link"
        case "note": "doc.text"
        case "image": "photo"
        case "voice": "mic"
        case "video": "video"
        case "clip": "scissors"
        case "pdf": "doc.richtext"
        case "social": "at"
        case "reminder": "bell"
        default: "doc.text"
        }
    }
}

/// The row's leading glyph: bare, coloured per type, in a 24pt lane.
struct InboxTypeIcon: View {
    let type: String
    @ScaledMetric(relativeTo: .body) private var lane: CGFloat = Tokens.Space.section

    var body: some View {
        Image(systemName: InboxTypeGlyph.symbol(type))
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Inbox.type(type).color)
            .frame(width: lane, height: Tokens.Size.minimumHitArea)
            .accessibilityHidden(true)
    }
}

/// One piece of a meta line and whether it is drawn in the amber accent
/// (voice duration, a reminder's kind, a stale age).
struct InboxMetaPart: Equatable {
    let text: String
    var accented = false
}

/// What a row says under its title (00 rule 3: one meta line, source or kind
/// then age; voice rows add the transcript).
struct InboxRowText: Equatable {
    let title: String
    /// The quoted transcript, or its state, for a voice memo.
    let preview: String?
    let meta: [InboxMetaPart]

    /// `archived`: desktop's archived list ages a row by `archivedAt` and
    /// never marks it stale (`inbox-archived-view.tsx`).
    static func make(_ item: InboxItemRecord, now: Date, staleDays: Int = 7, archived: Bool = false) -> InboxRowText {
        let meta = InboxMeta.metadata(item)
        var parts: [InboxMetaPart] = []
        switch item.itemType {
        case "link", "clip", "social":
            if let url = item.sourceUrl, let domain = InboxMeta.domain(url) {
                parts.append(InboxMetaPart(text: domain))
            }
        case "voice":
            if let duration = meta["duration"] as? Double {
                parts.append(InboxMetaPart(text: InboxMeta.duration(duration), accented: true))
            }
        case "image":
            parts.append(InboxMetaPart(text: InboxMeta.photoLine(meta)))
        case "pdf":
            if let pages = (meta["pageCount"] as? NSNumber)?.intValue {
                parts.append(InboxMetaPart(text: InboxCopy.pageCount(pages)))
            }
        case "video":
            if let size = (meta["fileSize"] as? NSNumber)?.doubleValue {
                parts.append(InboxMetaPart(text: InboxMeta.byteString(size)))
            }
        case "reminder":
            let target = (meta["targetType"] as? String).map(InboxMeta.targetName) ?? ""
            let kind = target.isEmpty ? InboxCopy.typeName("reminder") : "\(InboxCopy.typeName("reminder")) · \(target)"
            parts.append(InboxMetaPart(text: kind, accented: true))
        default:
            break
        }
        let created = Date(timeIntervalSince1970: TimeInterval(item.createdAtMs) / 1000)
        if archived {
            let archivedAt = Date(timeIntervalSince1970: TimeInterval(item.archivedAtMs ?? item.createdAtMs) / 1000)
            parts.append(InboxMetaPart(text: InboxMeta.age(archivedAt, now: now)))
        } else {
            let stale = now.timeIntervalSince(created) > Double(staleDays) * 86_400
            parts.append(InboxMetaPart(text: InboxMeta.age(created, now: now), accented: stale))
        }
        return InboxRowText(title: InboxMeta.displayTitle(item), preview: InboxMeta.voicePreview(item), meta: parts)
    }

    /// VoiceOver's sentence for the row.
    var accessibility: String {
        ([title, preview].compactMap { $0 } + meta.map(\.text)).joined(separator: ", ")
    }
}

enum InboxMeta {
    /// `metadata` as a dictionary (`nil` keys when absent or not JSON).
    static func metadata(_ item: InboxItemRecord) -> [String: Any] {
        guard let text = item.metadataJson, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return object
    }

    /// Reminder rows show the target's title (desktop `rawDisplayTitle`).
    static func displayTitle(_ item: InboxItemRecord) -> String {
        if item.itemType == "reminder", let target = metadata(item)["targetTitle"] as? String, !target.isEmpty {
            return target
        }
        return item.title.isEmpty ? InboxCopy.untitled : item.title
    }

    static func voicePreview(_ item: InboxItemRecord) -> String? {
        guard item.itemType == "voice" else { return nil }
        if let text = item.transcription?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return "“\(text)”"
        }
        switch item.transcriptionStatus {
        case "pending", "processing": return InboxCopy.transcribing
        case "failed": return InboxCopy.transcriptionFailed
        default: return nil
        }
    }

    /// `extractDomain`: the host without `www.`.
    static func domain(_ url: String) -> String? {
        guard let host = URL(string: url)?.host(), !host.isEmpty else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// `formatDuration`: `m:ss`.
    static func duration(_ seconds: Double) -> String {
        let total = Int(max(0, seconds))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// `formatCompactRelativeTime`: now, 12m, 3h, 5d, then "Sep 3".
    static func age(_ date: Date, now: Date) -> String {
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        if days < 30 { return "\(days)d" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// "Photo · 2.1 MB" (Paper 01).
    static func photoLine(_ meta: [String: Any]) -> String {
        guard let size = (meta["fileSize"] as? NSNumber)?.doubleValue else { return InboxCopy.photo }
        return "\(InboxCopy.photo) · \(byteString(size))"
    }

    static func byteString(_ bytes: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    static func targetName(_ type: String) -> String {
        switch type {
        case "task": "Task"
        case "journal": "Journal"
        default: "Note"
        }
    }
}

/// Today / Yesterday / Older, by local calendar day (`groupItemsByTimePeriod`).
enum InboxPeriod: String, CaseIterable, Identifiable {
    case today, yesterday, older

    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: InboxCopy.sectionToday
        case .yesterday: InboxCopy.sectionYesterday
        case .older: InboxCopy.sectionOlder
        }
    }

    static func of(_ createdAtMs: Int64, now: Date, calendar: Calendar = .current) -> InboxPeriod {
        let date = Date(timeIntervalSince1970: TimeInterval(createdAtMs) / 1000)
        if calendar.isDate(date, inSameDayAs: now) { return .today }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) { return .yesterday }
        return .older
    }

    /// The groups that hold something, in order, each newest first.
    static func group(
        _ items: [InboxItemRecord], now: Date, by time: (InboxItemRecord) -> Int64 = \.createdAtMs
    ) -> [(InboxPeriod, [InboxItemRecord])] {
        let buckets = Dictionary(grouping: items) { of(time($0), now: now) }
        return allCases.compactMap { period in
            guard let rows = buckets[period], !rows.isEmpty else { return nil }
            return (period, rows)
        }
    }
}

/// A trailing thumbnail (Paper 01: 44pt, control radius, hairline), read from
/// the vault directory when this device holds the file.
struct InboxThumbnail: View {
    let url: URL?

    var body: some View {
        Group {
            if let url, let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Tokens.Canvas.surfaceActive.color
            }
        }
        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
        .clipShape(.rect(cornerRadius: Tokens.Radius.control))
        .overlay {
            RoundedRectangle(cornerRadius: Tokens.Radius.control)
                .strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline / 2)
        }
        .accessibilityHidden(true)
    }
}

extension InboxItemRecord: @retroactive Identifiable {}

import MemryCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// The cover's value types, split from `NoteCover.swift`; see its header.

// MARK: - The value

/// One of desktop's twelve cover washes (`COVER_WASHES`): a matte pigment
/// pair painted as a diagonal gradient. Order and colours match desktop, and
/// the order matters: `forSeed` indexes into it.
enum NoteCoverWash: String, CaseIterable, Identifiable, Sendable {
    case sage, sand, lilac, clay, ash, fog, wheat, moss, slate, bark, mist, plum

    var id: String { rawValue }

    /// `from` and `to` of the gradient, as desktop's hex pairs.
    var stops: (from: UInt32, to: UInt32) {
        switch self {
        case .sage: (0xDF_E7_E3, 0xB9_CC_C4)
        case .sand: (0xEF_E9_DD, 0xD6_C9_B0)
        case .lilac: (0xE4_E2_EA, 0xC2_BD_D1)
        case .clay: (0xEC_E3_E1, 0xD2_B8_B2)
        case .ash: (0xE8_E6_DF, 0xBF_BC_B2)
        case .fog: (0xD9_E0_E6, 0x9F_B0_BD)
        case .wheat: (0xF0_EC_E2, 0xC9_B9_8F)
        case .moss: (0xDB_E3_DA, 0xA3_B5_9C)
        case .slate: (0x2F_34_36, 0x5B_64_67)
        case .bark: (0xE9_E4_DE, 0xA8_9B_8C)
        case .mist: (0xE6_E9_EA, 0xB4_C2_C4)
        case .plum: (0xDC_D3_E0, 0x84_76_9A)
        }
    }

    /// The name desktop's picker gives it (`cover.picker.wash.*`).
    var name: String { rawValue.capitalized }

    /// The frontmatter value: `wash:sage`.
    var ref: String { "wash:\(rawValue)" }

    var gradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(uiColor: AdaptiveColor.RGB(hex: stops.from).uiColor),
                Color(uiColor: AdaptiveColor.RGB(hex: stops.to).uiColor),
            ],
            // 135deg: top-leading to bottom-trailing.
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    /// Desktop's `coverWashForSeed`: a wash picked from a note id, so a note
    /// whose picture is missing paints the same colour on every device. The
    /// hash runs over UTF-16 units, as `charCodeAt` does.
    static func forSeed(_ seed: String) -> NoteCoverWash {
        var hash: UInt32 = 0
        for unit in seed.utf16 {
            hash = hash &* 31 &+ UInt32(unit)
        }
        return allCases[Int(hash % UInt32(allCases.count))]
    }
}

/// A parsed cover. Parsed once, the way desktop's `parseCoverValue` is, so no
/// view re-decides what a raw ref means.
struct NoteCoverValue: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// A vault path or an http(s) URL.
        case image(String)
        case wash(NoteCoverWash)
    }

    /// The raw `cover` value, written back unchanged on a reposition.
    let ref: String
    let kind: Kind
    /// Vertical focus of an image, 0 (top) to 100 (bottom).
    let focus: Int
    let credit: String?
    let creditUrl: URL?

    /// The centre, desktop's `DEFAULT_COVER_FOCUS`.
    static let defaultFocus = 50

    /// Desktop's `COVER_IMAGE_EXTENSIONS`.
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]

    /// Reads `NoteMetadata.coverJson`. `nil` for no cover and for a ref
    /// desktop would not read as one, except a `legacy` cover (an older iOS
    /// build's `coverImage`), whose picture is taken whatever its extension.
    static func of(_ json: String?) -> NoteCoverValue? {
        guard
            let json,
            let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
            let fields = object as? [String: Any],
            let ref = fields["ref"] as? String,
            let kind = (fields["legacy"] as? Bool == true) ? legacyKind(of: ref) : kind(of: ref)
        else { return nil }
        let focus = (fields["focus"] as? NSNumber).map { clampFocus($0.doubleValue) }
        let credit = (fields["credit"] as? String).flatMap {
            $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0
        }
        let creditUrl = (fields["creditUrl"] as? String).flatMap { isHTTP($0) ? URL(string: $0) : nil }
        return NoteCoverValue(
            ref: ref,
            kind: kind,
            focus: focus ?? defaultFocus,
            // Desktop shows a credit only with its link.
            credit: creditUrl == nil ? nil : credit,
            creditUrl: credit == nil ? nil : creditUrl
        )
    }

    /// Desktop's `parseCoverValue`: a known wash, an http(s) URL, or a path
    /// ending in an image extension. Anything else is prose, not a cover.
    static func kind(of ref: String) -> Kind? {
        if ref.hasPrefix("wash:") {
            return NoteCoverWash(rawValue: String(ref.dropFirst("wash:".count))).map(Kind.wash)
        }
        guard !ref.isEmpty else { return nil }
        if isHTTP(ref) { return .image(ref) }
        let path = ref.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""
        let ext = (path as NSString).pathExtension.lowercased()
        return imageExtensions.contains(ext) ? .image(ref) : nil
    }

    /// An older iOS build's `coverImage` url: any picture it attached, HEIC
    /// included, so no extension gate. It never wrote a wash.
    static func legacyKind(of ref: String) -> Kind? {
        ref.isEmpty ? nil : .image(ref)
    }

    /// Desktop's `clampCoverFocus`.
    static func clampFocus(_ value: Double) -> Int {
        guard value.isFinite else { return defaultFocus }
        return Int(min(100, max(0, value.rounded())))
    }

    private static func isHTTP(_ value: String) -> Bool {
        let lowered = value.lowercased()
        return lowered.hasPrefix("http://") || lowered.hasPrefix("https://")
    }
}

/// Where a cover picture's bytes live on this device.
enum NoteCoverSource: Equatable, Sendable {
    /// A link, drawn straight from the web as desktop draws it.
    case remote(URL)
    /// A note attachment: the note whose references hold it, and the url the
    /// core's block resolver binds by basename.
    case attachment(ownerNoteId: String, url: String)

    /// Resolves an image ref against the note that carries it.
    ///
    /// `attachments/<owner>/<file>`, alone or behind `../` segments, names the
    /// owning note: a cover desktop picked from another note's images lives in
    /// that note's references. Any other relative path binds against this
    /// note, as a block's url does.
    static func of(_ ref: String, noteId: String) -> NoteCoverSource? {
        let lowered = ref.lowercased()
        if lowered.hasPrefix("http://") || lowered.hasPrefix("https://") {
            return URL(string: ref).map(Self.remote)
        }
        let decoded = ref.removingPercentEncoding ?? ref
        let segments = decoded.replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/").map(String.init)
        if let index = segments.lastIndex(of: "attachments"),
           segments.count - index >= 3,
           let file = segments.last
        {
            return .attachment(ownerNoteId: segments[index + 1], url: file)
        }
        return .attachment(ownerNoteId: noteId, url: ref)
    }
}

/// Turning a picked picture into a cover upload.
enum NoteCoverUpload {
    /// The formats desktop draws as a cover and every Memry client can show.
    /// Anything else (HEIC from the camera roll, TIFF, a RAW) is re-encoded as
    /// JPEG: desktop's value gate would read `cover: x.heic` as a text
    /// property, and its renderer cannot draw one.
    static let keptExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

    struct Prepared: Equatable {
        let filename: String
        let mimeType: String
        let bytes: Data
    }

    /// - Parameters:
    ///   - fileExtension: the picked item's own extension, if it has one.
    ///   - stamp: the unique part of the filename. A fresh name per cover,
    ///     because desktop writes an attachment under its manifest filename
    ///     and a name already in the note's folder would be written beside it
    ///     under another one, leaving the ref pointing at the wrong picture.
    /// - Returns: `nil` when the bytes are not a picture this device can read.
    static func prepare(bytes: Data, fileExtension: String?, stamp: String) -> Prepared? {
        let ext = fileExtension?.lowercased() ?? ""
        if keptExtensions.contains(ext), UIImage(data: bytes) != nil {
            let normalized = ext == "jpeg" ? "jpg" : ext
            return Prepared(
                filename: "cover-\(stamp).\(normalized)",
                mimeType: UTType(filenameExtension: normalized)?.preferredMIMEType ?? "image/\(normalized)",
                bytes: bytes
            )
        }
        guard let image = UIImage(data: bytes), let jpeg = image.jpegData(compressionQuality: 0.85)
        else { return nil }
        return Prepared(filename: "cover-\(stamp).jpg", mimeType: "image/jpeg", bytes: jpeg)
    }

    /// The ref to store: the path desktop resolves for this note's attachment.
    static func ref(noteId: String, filename: String) -> String {
        "attachments/\(noteId)/\(filename)"
    }

    static func stamp(at date: Date = .now) -> String {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withYear, .withMonth, .withDay, .withTime]
        let suffix = UUID().uuidString.prefix(6).lowercased()
        return "\(format.string(from: date).replacingOccurrences(of: ":", with: "-"))-\(suffix)"
    }
}

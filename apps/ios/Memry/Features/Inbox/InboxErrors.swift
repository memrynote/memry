import Foundation

// IB031. The inbox's own failure sentences, for refusals the shell decides
// before the core is asked (desktop's `toast.failed*` and `loading.*`). Core
// errors still go through `ErrorMapping`.

enum InboxErrors {
    private static func make(_ code: ErrorCode, _ title: String, _ guidance: String?) -> UserFacingError {
        UserFacingError(code: code, title: title, guidance: guidance, recourse: .blocked, isUserVisible: true)
    }

    /// A file capture whose bytes are on the capturing device (§5 F3).
    static let fileElsewhere = make(
        "inbox.fileElsewhere",
        "This file is on the device that captured it.",
        "File it there, or archive it here. Nothing was changed."
    )

    /// Filing a file needs the upload, which needs a session.
    static let offline = make(
        "inbox.uploadUnavailable",
        "Filing a file needs a connection to Memry.",
        "It stays in the inbox. Nothing was changed."
    )

    /// `loading.unsupportedImageType` / desktop's MIME allow-list.
    static let unsupportedType = make(
        "inbox.unsupportedType",
        "This file type can't be captured.",
        "Images, audio, video and PDFs up to 50 MB can be."
    )

    /// `loading.imageTooLarge`.
    static let tooLarge = make(
        "inbox.tooLarge",
        "File too large (max 50MB).",
        "Nothing was captured."
    )

    /// The row for a file `checkFile` refused: its size, else its type.
    static func fileRefusal(size: UInt64) -> UserFacingError {
        size > 50 * 1024 * 1024 ? tooLarge : unsupportedType
    }

    /// A dropped file the provider would not hand over or that would not copy.
    static let dropUnreadable = make(
        "inbox.dropUnreadable",
        "A dropped file couldn't be copied.",
        "Nothing was captured. Try dropping it again."
    )

    /// A dropped file copied but would not open.
    static let dropUnopenable = make(
        "inbox.dropUnopenable",
        "A dropped file couldn't be opened.",
        "Nothing was captured from it. Try dropping it again."
    )

    /// More than one item of a drop failed, for whatever reasons; `first`
    /// is the first one's row, when it has one.
    static func dropFailed(_ count: Int, first: UserFacingError?) -> UserFacingError {
        make("inbox.dropFailed", "\(count) items couldn't be added.", first.map { "One reason: \($0.title)" })
    }

    static let microphoneDenied = make(
        "inbox.microphoneDenied",
        "Microphone access denied.",
        "Allow Memry to use the microphone in Settings to record voice memos."
    )

    static let noMicrophone = make(
        "inbox.noMicrophone",
        "No microphone found.",
        "Voice memos need a microphone. Nothing was recorded."
    )

    static let recordingFailed = make(
        "inbox.recordingFailed",
        "Failed to start recording.",
        "Nothing was recorded. Try again."
    )
}

import Foundation

enum SemanticSearchCopy {
    static let title = "Semantic search"
    static let toggle = "Search by meaning"
    static let toggleDetail = "Finds notes by what they mean, not only by their words."
    /// A search row only the meaning found, in place of its snippet.
    static let similarMeaning = "Similar meaning"

    static func footer(size: String) -> String {
        "Downloads a \(size) model once, on Wi-Fi only. A personal hotspot or Low Data Mode counts as cellular, so the "
            + "download waits for Wi-Fi. The model and the search index stay on this \(ThisDevice.noun) and never sync."
    }

    static let downloading = "Downloading model"
    static let waitingForWifi = "Waiting for Wi-Fi"
    static func progress(received: String, total: String) -> String { "\(received) of \(total)" }
    static func paused(received: String, total: String) -> String {
        "Paused at \(received) of \(total). Continues on Wi-Fi."
    }

    static let ready = "Model ready"
    static let indexed = "Notes indexed"
    static func indexedCount(_ embedded: UInt32, of total: UInt32) -> String { "\(embedded) of \(total)" }

    static let damagedTitle = "The download was damaged."
    static let damagedGuidance = "Memry deleted the damaged part. Try again to download it fresh."
    static let serverTitle = "The download server did not answer as expected."
    static let serverGuidance = "Nothing was saved from that answer. Try again later."
    static let networkTitle = "The download stopped."
    static let networkGuidance = "Check your connection, then try again. It continues where it stopped."
    static let retry = "Try again"

    static let turnOffTitle = "Turn off semantic search?"
    static func turnOffMessage(size: String) -> String {
        "This deletes the \(size) model and the search index from this \(ThisDevice.noun). Your notes are not changed. "
            + "Turning it on again downloads the model again."
    }
    static let turnOffConfirm = "Turn off and delete"
}

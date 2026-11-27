import Foundation
import MemryCore

extension ErrorMapping {
    static func userFacing(_ error: SemanticError) -> UserFacingError {
        switch error {
        case let .Storage(source): userFacing(source)
        case .Unavailable: semanticUnavailable
        case .Inference, .Poisoned: semanticInference
        }
    }

    static let semanticUnavailable = UserFacingError(
        code: "semantic.unavailable",
        title: "Semantic search is not available in this build.",
        guidance: "Search by words still works.",
        recourse: .blocked,
        isUserVisible: true
    )

    static let semanticNoStorage = UserFacingError(
        code: "semantic.noStorage",
        title: "Semantic search could not prepare its storage.",
        guidance: "Search by words still works. Close Memry and open it again to retry.",
        recourse: .retry,
        isUserVisible: true
    )

    static let semanticInference = UserFacingError(
        code: "semantic.inference",
        title: "Semantic search hit a problem.",
        guidance: "Search by words still works. Memry will try again later.",
        recourse: .retryLater,
        isUserVisible: true
    )
}

import Foundation
import MemryCore

// #4649. A refused property write, such as the Full width toggle on a note
// whose `fullWidth` holds text. The sentence names the property, which is the
// user's own label and not a secret, because "a property" leaves them nothing
// to look for. `existing` and `proposed` are the core's fixed words for a JSON
// type ("text", "a number", "a boolean"), so they read as written.
extension ErrorMapping {
    static func userFacing(_ error: PropertyWriteError) -> UserFacingError {
        switch error {
        case let .Retyped(name, existing, proposed):
            UserFacingError(
                code: "property.retyped",
                title: "\u{201C}\(name)\u{201D} holds \(existing), so Memry did not change it to \(proposed).",
                guidance: "Change its type or value in Properties first.",
                recourse: .blocked,
                isUserVisible: true
            )
        case let .Storage(source):
            userFacing(source)
        }
    }
}

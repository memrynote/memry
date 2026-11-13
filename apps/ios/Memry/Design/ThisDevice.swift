import Foundation
import UIKit

/// The one owner of what copy and symbols call this device: "iPad" on an
/// iPad, "iPhone" everywhere else. Nouns and symbols only; layout reads size
/// classes, never this.
enum ThisDevice {
    /// Read once. `UIDevice` is main-actor API, while copy enums and error
    /// mapping read the noun from any thread.
    static let isPad: Bool = Thread.isMainThread
        ? MainActor.assumeIsolated { UIDevice.current.userInterfaceIdiom == .pad }
        : DispatchQueue.main.sync { MainActor.assumeIsolated { UIDevice.current.userInterfaceIdiom == .pad } }

    static let noun = isPad ? "iPad" : "iPhone"
    static let symbol = isPad ? "ipad" : "iphone"
    static let symbolGenerational = isPad ? "ipad.gen2" : "iphone.gen3"
    static let symbolSlash = isPad ? "ipad.gen2.slash" : "iphone.slash"
    static let symbolWithLaptop = isPad ? "laptopcomputer.and.ipad" : "laptopcomputer.and.iphone"
}

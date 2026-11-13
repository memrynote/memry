import SwiftUI
import Testing
@testable import Memry

// Home's limitation screen at each width (#4460, L2 and L3 on #4353).

@Suite("Home chrome")
struct HomeChromeTests {
    @Test func regular_width_moves_capture_into_the_toolbar_and_drops_vault_and_search() {
        let width = LayoutWidth(horizontal: .regular, vertical: .regular)
        #expect(HomeChrome.items(width: width, canCapture: true, canSwitchVault: true) == [.capture])
        #expect(HomeChrome.items(width: width, canCapture: false, canSwitchVault: true).isEmpty)
    }

    @Test func compact_width_keeps_the_floating_plus_and_both_toolbar_items() {
        for width in [
            LayoutWidth(horizontal: .compact, vertical: .regular),
            LayoutWidth(horizontal: .regular, vertical: .compact),
        ] {
            #expect(HomeChrome.items(width: width, canCapture: true, canSwitchVault: true) == [.floatingCapture, .switchVault, .search])
            #expect(HomeChrome.items(width: width, canCapture: true, canSwitchVault: false) == [.floatingCapture, .search])
            #expect(HomeChrome.items(width: width, canCapture: false, canSwitchVault: false) == [.search])
        }
    }
}

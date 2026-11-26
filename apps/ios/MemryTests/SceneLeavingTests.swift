import Combine
import Testing
import UIKit
@testable import Memry

/// #5820: a window's views hear their own scene leaving as well as the app,
/// and one transition, posted by both, once.
@MainActor
@Suite("Scene leaving")
struct SceneLeavingTests {
    /// A private center: the app-wide one reaches every suite's pages.
    private let center = NotificationCenter()
    private let scene = NSObject()

    private func heard(_ posts: [(Notification.Name, AnyObject?)]) -> [SceneLeave] {
        var leaves: [SceneLeave] = []
        let subscription = SceneLeaving.publisher(of: { scene }, center: center).sink { leaves.append($0) }
        for (name, object) in posts { center.post(name: name, object: object) }
        subscription.cancel()
        return leaves
    }

    @Test func its_own_scene_leaving_is_heard_without_the_app() {
        #expect(heard([
            (UIScene.willDeactivateNotification, scene),
            (UIScene.didEnterBackgroundNotification, scene)
        ]) == [.resign, .background])
    }

    @Test func another_scene_leaving_is_not_heard() {
        let other = NSObject()
        #expect(heard([
            (UIScene.willDeactivateNotification, other),
            (UIScene.didEnterBackgroundNotification, other),
            (UIScene.didEnterBackgroundNotification, nil)
        ]).isEmpty)
    }

    /// One window: its scene and the app post each step, in either order.
    @Test func the_scene_and_the_app_leaving_together_are_heard_once() {
        #expect(heard([
            (UIScene.willDeactivateNotification, scene),
            (UIApplication.willResignActiveNotification, nil),
            (UIApplication.didEnterBackgroundNotification, nil),
            (UIScene.didEnterBackgroundNotification, scene)
        ]) == [.resign, .background])
    }

    /// A window that left earlier is not saved again as the last one leaves.
    @Test func the_app_leaving_after_the_window_left_is_not_heard_again() {
        #expect(heard([
            (UIScene.willDeactivateNotification, scene),
            (UIScene.didEnterBackgroundNotification, scene),
            (UIApplication.willResignActiveNotification, nil),
            (UIApplication.didEnterBackgroundNotification, nil)
        ]) == [.resign, .background])
    }

    @Test func coming_back_and_leaving_again_is_heard_again() {
        #expect(heard([
            (UIScene.willDeactivateNotification, scene),
            (UIScene.didActivateNotification, scene),
            (UIApplication.willResignActiveNotification, nil),
            (UIApplication.didBecomeActiveNotification, nil),
            (UIScene.willDeactivateNotification, scene)
        ]) == [.resign, .resign, .resign])
    }

    /// Each app-wide resign with no scene one to pair with is its own.
    @Test func two_app_resigns_are_both_heard() {
        #expect(heard([
            (UIApplication.willResignActiveNotification, nil),
            (UIApplication.willResignActiveNotification, nil)
        ]) == [.resign, .resign])
    }
}

import Combine
import UIKit

/// A window leaving the foreground: it resigns (Control Center, the app
/// switcher, another window taking the focus), then goes to the background.
enum SceneLeave: Equatable {
    case resign
    case background
}

/// When the views of one window save what they hold (#5820). On iPad with
/// several windows, a window that goes to the background posts only its
/// scene's notifications: `UIApplication`'s come once the last window
/// leaves. A view hears its own scene's and the app-wide ones, with the
/// scene read as each notification arrives, as a view moves between windows.
///
/// Example: with one window, its scene resigns and the app resigns in the
/// same transition. That is one `.resign`: an app-wide notification that
/// follows its scene's (or the other way round) is not heard again until
/// the window or the app becomes active. Two app-wide notifications of a
/// kind with no scene one between them are both heard.
enum SceneLeaving {
    /// `center`: the center the lifecycle notifications are posted to, the
    /// app-wide one outside tests.
    static func publisher(
        of scene: @escaping @MainActor () -> AnyObject?, center: NotificationCenter = .default
    ) -> AnyPublisher<SceneLeave, Never> {
        let app: [(Notification.Name, Signal)] = [
            (UIApplication.willResignActiveNotification, .leave(.resign, fromScene: false)),
            (UIApplication.didEnterBackgroundNotification, .leave(.background, fromScene: false)),
            (UIApplication.didBecomeActiveNotification, .active),
            (UIApplication.willEnterForegroundNotification, .active)
        ]
        let own: [(Notification.Name, Signal)] = [
            (UIScene.willDeactivateNotification, .leave(.resign, fromScene: true)),
            (UIScene.didEnterBackgroundNotification, .leave(.background, fromScene: true)),
            (UIScene.didActivateNotification, .active),
            (UIScene.willEnterForegroundNotification, .active)
        ]
        let signals = app.map { name, signal in
            center.publisher(for: name).map { _ in signal }.eraseToAnyPublisher()
        } + own.map { name, signal in
            center.publisher(for: name)
                .filter { note in
                    let posted = (note.object as AnyObject?).map(ObjectIdentifier.init)
                    return MainActor.assumeIsolated {
                        guard let scene = scene() else { return false }
                        return posted == ObjectIdentifier(scene)
                    }
                }
                .map { _ in signal }
                .eraseToAnyPublisher()
        }
        return Deferred {
            let pairs = Pairs()
            return Publishers.MergeMany(signals).compactMap { pairs.take($0) }
        }
        .eraseToAnyPublisher()
    }

    private enum Signal {
        case leave(SceneLeave, fromScene: Bool)
        case active
    }

    /// The leaves heard from each source since the window or the app was
    /// last active, each waiting for its pair from the other source.
    private final class Pairs {
        private var heard: [Bool: Set<SceneLeave>] = [:]

        func take(_ signal: Signal) -> SceneLeave? {
            switch signal {
            case .active:
                heard = [:]
                return nil
            case let .leave(leave, fromScene):
                if heard[!fromScene]?.remove(leave) != nil { return nil }
                heard[fromScene, default: []].insert(leave)
                return leave
            }
        }
    }
}

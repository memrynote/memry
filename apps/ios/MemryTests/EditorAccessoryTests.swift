//
//  EditorAccessoryTests.swift
//  The keyboard toolbar in a window: the insert panel is as tall as the keys
//  below it, also when the toolbar was placed late, it grows with the `[[`,
//  `@` and `#` menus, the page with the caret steps it aside for a menu over
//  the page until the menu is gone, and a block left with the panel open
//  gets its keyboard back.
//

import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

extension KeyWindowSuites {
    @MainActor
    @Suite("the keyboard toolbar", .serialized)
    struct EditorAccessoryTests {
        private func window() throws -> UIWindow {
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = UIViewController()
            window.isHidden = false
            return window
        }

        /// Puts the toolbar where UIKit would: full width, its bottom
        /// `above` points over the screen's bottom edge.
        private func host(_ toolbar: UIView, in window: UIWindow, above: CGFloat) -> NSLayoutConstraint {
            window.addSubview(toolbar)
            let bottom = toolbar.bottomAnchor.constraint(equalTo: window.bottomAnchor, constant: -above)
            NSLayoutConstraint.activate([
                toolbar.leadingAnchor.constraint(equalTo: window.leadingAnchor),
                toolbar.trailingAnchor.constraint(equalTo: window.trailingAnchor),
                bottom,
            ])
            window.layoutIfNeeded()
            return bottom
        }

        private func keyboardWillShow(_ frame: CGRect, on screen: UIScreen) {
            NotificationCenter.default.post(
                name: UIResponder.keyboardWillShowNotification,
                object: screen,
                userInfo: [UIResponder.keyboardFrameEndUserInfoKey: frame, UIResponder.keyboardIsLocalUserInfoKey: true]
            )
        }

        @Test func the_insert_panel_is_as_tall_as_the_keys_below_the_toolbar() throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            let screen = try #require(window.windowScene?.screen)
            let toolbar = session.accessory
            let bottom = host(toolbar, in: window, above: 336)
            let height = toolbar.frame.height
            #expect(height > 0)

            // iOS 26's first frame for the keys reaches a bottom inset above
            // the toolbar.
            keyboardWillShow(
                CGRect(x: 0, y: screen.bounds.maxY - 336 - height - 34, width: screen.bounds.width, height: 336 + height + 34),
                on: screen
            )
            #expect(session.keyboardHeight == 336)

            // A hardware keyboard: only the toolbar is on screen, and the
            // frame runs off the bottom edge.
            bottom.constant = 0
            window.layoutIfNeeded()
            let floating = toolbar.frame.height
            keyboardWillShow(
                CGRect(x: 0, y: screen.bounds.maxY - floating, width: screen.bounds.width, height: floating + 311),
                on: screen
            )
            #expect(session.keyboardHeight == 336, "no keys below the toolbar, so the panel keeps its height")
        }

        @Test(.timeLimit(.minutes(1)), arguments: [" [[", " @", " #"])
        func the_toolbar_grows_when_its_menu_opens(typed: String) async throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            session.linkNotes = [NoteSummary(
                id: "dune", title: "Agent Dune", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
            )]
            session.tags = ["agent"]
            let toolbar = session.accessory
            _ = host(toolbar, in: window, above: 0)
            let closed = toolbar.frame.height

            // Typed as UIKit delivers keys to a text view with the caret.
            let textView = field.textView
            textView.selectedRange = NSRange(location: (textView.text as NSString).length, length: 0)
            for character in typed {
                if field.textView(textView, shouldChangeTextIn: textView.selectedRange, replacementText: String(character)) {
                    textView.insertText(String(character))
                    field.textViewDidChange(textView)
                }
            }
            #expect(session.menuOpen, "\(typed) opened no menu")
            for _ in 0 ..< 100 where toolbar.frame.height <= closed {
                try await Task.sleep(for: .milliseconds(20))
                window.layoutIfNeeded()
            }
            #expect(toolbar.frame.height > closed, "the toolbar stayed \(closed)pt with the \(typed) menu open")
        }

        private func keyboardMoved() {
            NotificationCenter.default.post(name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        }

        /// Whether `toolbar` shows within a second: a hidden one looks again
        /// on its own, without a notification.
        private func shows(_ toolbar: UIView) async throws -> Bool {
            for _ in 0 ..< 50 where toolbar.alpha == 0 {
                try await Task.sleep(for: .milliseconds(20))
            }
            return toolbar.alpha == 1
        }

        @Test(.timeLimit(.minutes(1))) func the_toolbar_steps_aside_while_a_menu_is_over_the_page() async throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            let root = try #require(window.rootViewController)

            await withCheckedContinuation { done in root.present(UIViewController(), animated: false) { done.resume() } }
            keyboardMoved()
            #expect(session.accessory.alpha == 0, "the toolbar covered the menu")

            // The keys come back while the menu is still on its way out, as
            // after a sheet's Cancel, and they do not move again.
            await withCheckedContinuation { done in
                root.dismiss(animated: true) { done.resume() }
                #expect(root.presentedViewController?.isBeingDismissed == true)
                keyboardMoved()
            }
            #expect(session.accessory.alpha == 1, "the toolbar stayed hidden after the menu closed")

            // A menu, alert or popover can go away with the keys left where
            // they were, so nothing is posted.
            await withCheckedContinuation { done in root.present(UIViewController(), animated: false) { done.resume() } }
            keyboardMoved()
            await withCheckedContinuation { done in root.dismiss(animated: true) { done.resume() } }
            #expect(try await shows(session.accessory), "the toolbar stayed hidden after a menu closed with no keyboard move")
        }

        @Test(.timeLimit(.minutes(1))) func a_sheet_swiped_down_that_snaps_back_hides_the_toolbar_again() async throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            let root = try #require(window.rootViewController)
            let swipe = SwipeDown()
            let sheet = UIViewController()
            sheet.modalPresentationStyle = .custom
            sheet.transitioningDelegate = swipe
            await withCheckedContinuation { done in root.present(sheet, animated: false) { done.resume() } }
            keyboardMoved()
            #expect(session.accessory.alpha == 0)

            // The keys come back as the drag starts, then the sheet snaps back
            // with nothing posted.
            sheet.dismiss(animated: true)
            #expect(sheet.isBeingDismissed)
            keyboardMoved()
            #expect(session.accessory.alpha == 1)
            swipe.drag.update(0.3)
            swipe.drag.cancel()
            for _ in 0 ..< 50 where sheet.isBeingDismissed || session.accessory.alpha == 1 {
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(root.presentedViewController === sheet)
            #expect(session.accessory.alpha == 0, "the toolbar showed over the sheet that snapped back")
            await withCheckedContinuation { done in root.dismiss(animated: false) { done.resume() } }
        }

        @Test func only_the_page_with_the_caret_moves_its_toolbar() async throws {
            let window = try window()
            defer { window.isHidden = true }
            let (focused, field) = focusedField(in: window)
            let (other, otherField) = focusedField(in: window)
            defer { withExtendedLifetime((field, otherField)) {} }
            // A journal day the caret left: its block is still drawn.
            other.focusChanged(to: nil)
            let root = try #require(window.rootViewController)

            await withCheckedContinuation { done in root.present(UIViewController(), animated: false) { done.resume() } }
            keyboardMoved()
            #expect(focused.accessory.alpha == 0)
            #expect(other.accessory.alpha == 1, "a page without the caret hid its toolbar")

            // The caret moves to the other page while the menu is up, then
            // back once it is gone.
            other.focusChanged(to: otherField)
            #expect(other.accessory.alpha == 0, "the page that took the caret showed its toolbar over the menu")
            await withCheckedContinuation { done in root.dismiss(animated: false) { done.resume() } }
            other.focusChanged(to: nil)
            focused.focusChanged(to: field)
            #expect(focused.accessory.alpha == 1, "the toolbar stayed hidden when the caret came back")
        }

        @Test func the_panel_is_measured_once_the_keys_show_when_the_toolbar_was_not_placed_yet() throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            let screen = try #require(window.windowScene?.screen)
            let toolbar = session.accessory
            let before = session.keyboardHeight
            func keys(_ name: Notification.Name, toolbarHeight height: CGFloat) {
                NotificationCenter.default.post(
                    name: name,
                    object: screen,
                    userInfo: [
                        UIResponder.keyboardFrameEndUserInfoKey: CGRect(
                            x: 0, y: screen.bounds.maxY - 336 - height, width: screen.bounds.width, height: 336 + height
                        ),
                        UIResponder.keyboardIsLocalUserInfoKey: true,
                    ]
                )
            }

            keys(UIResponder.keyboardWillShowNotification, toolbarHeight: 0)
            #expect(session.keyboardHeight == before, "a toolbar in no window was measured")

            _ = host(toolbar, in: window, above: 336)
            keys(UIResponder.keyboardDidShowNotification, toolbarHeight: toolbar.frame.height)
            #expect(session.keyboardHeight == 336, "the panel kept the default height")
        }

        @Test func a_block_left_with_the_insert_panel_open_gets_its_keyboard_back() throws {
            let window = try window()
            defer { window.isHidden = true }
            let (session, field) = focusedField(in: window)
            defer { withExtendedLifetime(field) {} }
            session.reduceMotion = { false }
            session.show(.insert)
            #expect(field.textView.inputView != nil)

            field.textViewDidEndEditing(field.textView)

            #expect(session.panel == .none)
            #expect(field.textView.inputView == nil, "the block shows an empty panel when the caret comes back")
        }
    }
}

/// A sheet's interactive swipe-down, driven by hand.
private final class SwipeDown: NSObject, UIViewControllerTransitioningDelegate, UIViewControllerAnimatedTransitioning {
    let drag = UIPercentDrivenInteractiveTransition()

    func animationController(forDismissed dismissed: UIViewController) -> (any UIViewControllerAnimatedTransitioning)? {
        self
    }

    func interactionControllerForDismissal(
        using animator: any UIViewControllerAnimatedTransitioning
    ) -> (any UIViewControllerInteractiveTransitioning)? {
        drag
    }

    func transitionDuration(using context: (any UIViewControllerContextTransitioning)?) -> TimeInterval { 0.3 }

    func animateTransition(using context: any UIViewControllerContextTransitioning) {
        let sheet = context.view(forKey: .from)
        UIView.animate(withDuration: 0.3) {
            sheet?.frame.origin.y += context.containerView.bounds.height
        } completion: { _ in
            context.completeTransition(!context.transitionWasCancelled)
        }
    }
}

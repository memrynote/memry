import { Stack } from 'expo-router'

export default function NotesLayout() {
  // Every screen in this stack draws its own nav bar (boards 26, 27, 28/29).
  // Left `true`, the native header renders for the whole push animation and is
  // only torn down once a per-screen `Stack.Screen` override lands a frame
  // later — a second bar visibly stacked over the real one on every open.
  return <Stack screenOptions={{ headerShown: false }} />
}

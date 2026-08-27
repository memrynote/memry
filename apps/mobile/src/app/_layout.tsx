// Hermes has no global crypto.getRandomValues; nanoid (via @memry/app-core)
// needs it. Must be the first import (R3 spike finding).
import '@/lib/crypto-polyfill'

import { useEffect } from 'react'
import { DarkTheme, DefaultTheme, ThemeProvider, Stack } from 'expo-router'
import * as Linking from 'expo-linking'
import * as SplashScreen from 'expo-splash-screen'
import { useColorScheme } from 'react-native'

import { AnimatedSplashOverlay } from '@/components/animated-icon'
import { setDevOffline } from '@/lib/dev-network'

SplashScreen.preventAutoHideAsync()

/**
 * `memry:///dev-network?offline=1|0` — the offline matrix's network lever.
 *
 * Handled here rather than as a route, deliberately: a route would NAVIGATE,
 * and the matrix toggles the network in the middle of a flow that is somewhere
 * else entirely. This flips the switch and leaves the screen alone, so
 * `xcrun simctl openurl` is a network transition and nothing more.
 *
 * `setDevOffline` is a no-op outside `__DEV__`, so this link does nothing in a
 * release build.
 */
function useDevNetworkLink(): void {
  useEffect(() => {
    const apply = (url: string | null): void => {
      if (!url) return
      const { hostname, path, queryParams } = Linking.parse(url)
      if (hostname !== 'dev-network' && path !== 'dev-network') return
      setDevOffline(queryParams?.offline === '1')
    }

    void Linking.getInitialURL().then(apply)
    const subscription = Linking.addEventListener('url', ({ url }) => apply(url))
    return () => subscription.remove()
  }, [])
}

export default function RootLayout() {
  const colorScheme = useColorScheme()
  useDevNetworkLink()
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(vault)" />
        <Stack.Screen name="(dev)" />
      </Stack>
    </ThemeProvider>
  )
}

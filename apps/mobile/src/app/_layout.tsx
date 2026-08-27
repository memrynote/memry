// Hermes has no global crypto.getRandomValues; nanoid (via @memry/app-core)
// needs it. Must be the first import (R3 spike finding).
import '@/lib/crypto-polyfill'

import { useFonts } from 'expo-font'
import { DarkTheme, DefaultTheme, ThemeProvider, Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useColorScheme } from 'react-native'

import { AnimatedSplashOverlay } from '@/components/animated-icon'
import { fontAssets } from '@/theme/fonts'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const colorScheme = useColorScheme()
  const [fontsLoaded, fontError] = useFonts(fontAssets)

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/*
        Mounted outside the font gate on purpose. This overlay is what calls
        SplashScreen.hideAsync, so no font outcome can strand the native splash
        on screen. The gate below opens on either terminal state of useFonts,
        and a font failure renders the app with system fallbacks.
      */}
      <AnimatedSplashOverlay />
      {fontsLoaded || fontError ? (
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(vault)" />
          <Stack.Screen name="(dev)" />
        </Stack>
      ) : null}
    </ThemeProvider>
  )
}

// Hermes has no global crypto.getRandomValues; nanoid (via @memry/app-core)
// needs it. Must be the first import (R3 spike finding).
import '@/lib/crypto-polyfill'

import { DarkTheme, DefaultTheme, ThemeProvider, Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useColorScheme } from 'react-native'

import { AnimatedSplashOverlay } from '@/components/animated-icon'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const colorScheme = useColorScheme()
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

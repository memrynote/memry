// Hermes has no global crypto.getRandomValues; nanoid (via @memry/app-core)
// needs it. Must be the first import (R3 spike finding).
import '@/lib/crypto-polyfill'

import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useColorScheme } from 'react-native'

import { AnimatedSplashOverlay } from '@/components/animated-icon'
import AppTabs from '@/components/app-tabs'

SplashScreen.preventAutoHideAsync()

export default function TabLayout() {
  const colorScheme = useColorScheme()
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <AppTabs />
    </ThemeProvider>
  )
}

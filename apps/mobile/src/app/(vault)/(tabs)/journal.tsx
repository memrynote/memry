import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { EmptyState } from '@/components/ui/empty-state'
import { useColors } from '@/theme/use-colors'

export default function JournalScreen() {
  const c = useColors()
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.canvas.background }]}>
      <View style={styles.center}>
        <EmptyState icon="journal" title="Journal" body="This tab arrives in a later pass." />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' }
})

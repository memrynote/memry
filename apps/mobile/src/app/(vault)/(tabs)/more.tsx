import { router } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { EmptyState } from '@/components/ui/empty-state'
import { ListRow } from '@/components/ui/list-row'
import { SectionHeader } from '@/components/ui/section-header'
import { useColors } from '@/theme/use-colors'

export default function MoreScreen() {
  const c = useColors()
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.canvas.background }]}>
      <View style={styles.center}>
        <EmptyState icon="more" title="More" body="This tab arrives in a later pass." />
      </View>
      {__DEV__ ? (
        <View>
          <SectionHeader label="Developer" />
          <ListRow
            variant="setting"
            title="Component gallery"
            onPress={() => router.push('/gallery')}
          />
          <ListRow
            variant="setting"
            title="Seam tests"
            onPress={() => router.push('/seam-tests')}
          />
        </View>
      ) : null}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' }
})

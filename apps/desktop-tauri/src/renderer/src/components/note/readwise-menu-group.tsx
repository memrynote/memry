import { useT } from '@memry/i18n/renderer'
import { Picker } from '@/components/ui/picker'
import { RefreshCw, Undo } from '@/lib/icons'
import type { ReadwiseBookCommands } from '@/pages/note/use-readwise-book-commands'

interface ReadwiseMenuGroupProps {
  readwise: ReadwiseBookCommands
  labels: { 'note.readwiseReimport': string; 'note.readwiseRefresh': string }
}

/**
 * The Readwise group of the note menu (#1408 D16). On a device that does not
 * pull, the items stay visible but disabled and the hint names the device that
 * does, because only that one holds the token.
 */
export function ReadwiseMenuGroup({ readwise, labels }: ReadwiseMenuGroupProps): React.JSX.Element {
  const { t } = useT('notes')
  const disabled = !readwise.pullsHere
  const disabledClass = 'disabled:pointer-events-none disabled:opacity-45'
  return (
    <>
      <Picker.Separator />
      <Picker.Section label={t('readwise.group')}>
        <Picker.Item
          value="note.readwiseReimport"
          label={labels['note.readwiseReimport']}
          icon={<RefreshCw className="size-4" />}
          disabled={disabled}
          className={disabledClass}
        />
        <Picker.Item
          value="note.readwiseRefresh"
          label={labels['note.readwiseRefresh']}
          icon={<Undo className="size-4" />}
          disabled={disabled}
          className={disabledClass}
        />
        {disabled && (
          <div className="px-2 pb-1 pt-1.5 text-xs/4 text-muted-foreground">
            <p>
              {readwise.pullingDeviceName
                ? t('readwise.syncsOn', { device: readwise.pullingDeviceName })
                : t('readwise.syncsOnAnotherDevice')}
            </p>
            <p>{t('readwise.takeOverHint')}</p>
          </div>
        )}
      </Picker.Section>
    </>
  )
}

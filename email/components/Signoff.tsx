import { Hr, Text } from '@react-email/components'

type SignoffProps = {
  launchLine: string
  name?: string
}

const styles = {
  hr: {
    border: 'none',
    borderTop: '1px solid #e7e5e4',
    margin: '32px 0 24px 0'
  } as const,
  launchLine: {
    margin: '0 0 16px 0',
    fontSize: 14,
    color: '#71717a'
  } as const,
  name: {
    margin: 0,
    fontSize: 15,
    color: '#27272a'
  } as const
}

export function Signoff({ launchLine, name = 'Kaan' }: SignoffProps) {
  return (
    <>
      <Hr style={styles.hr} />
      <Text style={styles.launchLine}>{launchLine}</Text>
      <Text style={styles.name}>— {name}</Text>
    </>
  )
}

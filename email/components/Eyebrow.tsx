import { Text } from '@react-email/components'

type EyebrowProps = {
  label: string
  index: number
  total: number
}

const style = {
  margin: '0 0 12px 0',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color: '#ea580c'
}

export function Eyebrow({ label, index, total }: EyebrowProps) {
  const padded = String(index).padStart(2, '0')
  const totalPadded = String(total).padStart(2, '0')
  return (
    <Text style={style}>
      {label} · {padded} / {totalPadded}
    </Text>
  )
}

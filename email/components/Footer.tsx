import { Hr, Link, Section, Text } from '@react-email/components'

const styles = {
  hr: {
    border: 'none',
    borderTop: '1px solid #e7e5e4',
    margin: '40px 0 24px 0'
  } as const,
  wrapper: {
    textAlign: 'center' as const,
    padding: '0 0 8px 0'
  } as const,
  brand: {
    margin: '0 0 12px 0',
    fontSize: 16,
    fontWeight: 600,
    color: '#27272a'
  } as const,
  meta: {
    margin: '0 0 6px 0',
    fontSize: 12,
    color: '#a1a1aa'
  } as const,
  links: {
    margin: '8px 0 0 0',
    fontSize: 12,
    color: '#71717a'
  } as const,
  link: {
    color: '#71717a',
    textDecoration: 'underline'
  } as const
}

export function Footer() {
  return (
    <>
      <Hr style={styles.hr} />
      <Section style={styles.wrapper}>
        <Text style={styles.brand}>Memry</Text>
        <Text style={styles.meta}>
          You signed up for the Memry waitlist. We send one update each week until launch.
        </Text>
        <Text style={styles.links}>
          <Link href="https://memry.app" style={styles.link}>
            memry.app
          </Link>
          {' · '}
          <Link href="{{{RESEND_UNSUBSCRIBE_URL}}}" style={styles.link}>
            unsubscribe
          </Link>
        </Text>
      </Section>
    </>
  )
}

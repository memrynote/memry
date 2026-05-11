import { Body, Container, Font, Head, Html, Preview, Section } from '@react-email/components'
import type { ReactNode } from 'react'

type LayoutProps = {
  preview: string
  children: ReactNode
}

const styles = {
  body: {
    margin: 0,
    padding: 0,
    backgroundColor: '#fafaf9',
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: '#27272a'
  } as const,
  container: {
    maxWidth: 600,
    margin: '0 auto',
    backgroundColor: '#ffffff',
    border: '1px solid #e7e5e4',
    borderRadius: 12
  } as const,
  inner: {
    padding: '40px 32px'
  } as const
}

export function Layout({ preview, children }: LayoutProps) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <Font
          fontFamily="Inter"
          fallbackFontFamily="Helvetica"
          webFont={{
            url: 'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2',
            format: 'woff2'
          }}
          fontWeight={400}
          fontStyle="normal"
        />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.inner}>{children}</Section>
        </Container>
      </Body>
    </Html>
  )
}

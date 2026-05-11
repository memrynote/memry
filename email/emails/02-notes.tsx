import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = "Encrypted notes, exactly how you'd expect"
export const preview = 'End-to-end encryption, on by default.'

export default function Email02Notes() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="NOTES" index={2} total={TOTAL_EMAILS} />
      <Heading style={heading}>Encrypted notes, exactly how you would expect.</Heading>
      <Text style={subhead}>A block editor with strong privacy underneath.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        The notes you write in Memry live on your device first. When they sync, they travel
        encrypted. The server holds blobs it cannot read.
      </Text>

      <HeroImage
        alt="Block editor with notes open"
        caption="The Memry editor. Paragraphs, headings, callouts, code, tables."
      />

      <Text style={body}>
        The editor is block based. Paragraphs, headings, lists, code, callouts, images, and tables.
        Drag a block, nest it, or turn it into something else with a slash command. It feels like
        Notion. It does not feel like writing inside a database.
      </Text>

      <InlineImage alt="Slash menu open inside the editor" />

      <Heading as="h2" style={sectionHeading}>
        How the encryption works
      </Heading>
      <Text style={body}>
        Memry uses XChaCha20-Poly1305 for content and Ed25519 for signing. Your master key comes
        from your passphrase through Argon2id. The keys never leave your machine. We could not read
        your notes if we wanted to.
      </Text>

      <InlineImage alt="Vault unlock screen with encryption indicator" />

      <Text style={body}>
        We chose this because the apps that ask you to write down what matters should not also
        collect what matters. The math here is older than us. It is settled. We just used it.
      </Text>

      <Signoff launchLine="Launching in 7 weeks." />
      <Footer />
    </Layout>
  )
}

Email02Notes.PreviewProps = {}

import { LegalLayout } from '@/components/shared/LegalLayout'
import { PageHead } from '@/components/shared/PageHead'

export function PrivacyPage() {
  return (
    <>
      <PageHead page="privacy" />
      <LegalLayout
        eyebrow="Legal · Privacy"
        title="Privacy Policy"
        intro="Memry is built on a simple promise: your notes belong to you, and we cannot read them."
        lastUpdated="May 9, 2026"
      >
        <h2>Summary in 30 seconds</h2>
        <ul>
          <li>The local app stores everything on your device. We never see it.</li>
          <li>
            Sync uploads only ciphertext. Every byte is encrypted on your device with
            XChaCha20-Poly1305 before it leaves.
          </li>
          <li>Encryption keys live in your password manager and never touch our servers.</li>
          <li>We collect the minimum metadata needed to bill, deliver, and secure the service.</li>
          <li>We never sell your data. We have nothing to sell.</li>
        </ul>

        <h2>1. What this policy covers</h2>
        <p>
          This policy describes how Memry handles personal data in the desktop app, the marketing
          website, and the optional Sync service. It applies to everyone who uses Memry, regardless
          of country.
        </p>

        <h2>2. The local app collects nothing</h2>
        <p>
          The Memry desktop application runs entirely on your computer. Your notes, tasks, journal,
          and files are stored as plain Markdown files in a vault folder you choose. None of that
          content is sent to us, period.
        </p>
        <p>
          We do not include analytics, telemetry, or crash reporting that transmits your content.
          Optional update checks contact our update server, which sees only your IP address and app
          version.
        </p>

        <h2>3. What Sync sends to our servers</h2>
        <p>If you opt into the paid Sync service, the following is uploaded:</p>
        <ul>
          <li>
            <strong>Encrypted blobs.</strong> Notes, tasks, journals, attachments, and metadata, all
            encrypted on your device before upload. We hold ciphertext only.
          </li>
          <li>
            <strong>Routing metadata.</strong> Vault IDs, blob keys, content hashes, byte counts,
            and timestamps. These are needed to route updates to your other devices and to count
            usage against your plan.
          </li>
          <li>
            <strong>Account identifiers.</strong> Your email address, a hashed password, and
            verification tokens.
          </li>
        </ul>
        <p>
          We do not receive plaintext titles, plaintext tags, or any contents of your vault. The
          server&apos;s view of your notes is a stream of opaque encrypted bytes.
        </p>

        <h2>4. What the website collects</h2>
        <p>
          Memrynote.com uses minimal, privacy-respecting analytics to understand how people find the
          site and which pages are useful. We do not use third-party advertising trackers and do not
          sell visitor data.
        </p>
        <p>
          If you join the waitlist or contact us, we store the email address you submit so we can
          reply or send the messages you opted into.
        </p>

        <h2>5. How we use the data we have</h2>
        <p>We use the data described above only to:</p>
        <ul>
          <li>Operate, sync, and secure your account.</li>
          <li>Bill you, through Paddle, for the plan you chose.</li>
          <li>
            Send transactional email (sign-up confirmation, payment receipts, security notices).
          </li>
          <li>Investigate abuse, debug crashes, and improve product quality.</li>
          <li>Comply with legal obligations.</li>
        </ul>
        <p>
          We do not use your data to train models, build advertising profiles, or sell anything to
          anyone.
        </p>

        <h2>6. Encryption details</h2>
        <p>
          Memry uses end-to-end encryption based on the libsodium primitives: XChaCha20-Poly1305 for
          content, Ed25519 for signatures, and Argon2id for password-based key derivation. Your
          master key is derived from your password on your device and is never sent to us.
        </p>
        <p>
          Because we never hold your keys, we cannot decrypt your data. We cannot reset it for you,
          and we cannot disclose its contents in response to a subpoena — we have no way to read it
          ourselves.
        </p>

        <h2>7. Sub-processors</h2>
        <p>
          We use a small set of third-party services to operate Memry. Each is contractually bound
          to handle your data only for the purpose listed:
        </p>
        <ul>
          <li>
            <strong>Cloudflare</strong> — hosts the Sync API, stores encrypted blobs in R2, and runs
            the marketing website&apos;s edge.
          </li>
          <li>
            <strong>Paddle</strong> — merchant of record for payments. Receives billing details
            (name, billing address, payment method).
          </li>
          <li>
            <strong>Postmark or a similar transactional email provider</strong> — delivers sign-up,
            billing, and security emails.
          </li>
        </ul>
        <p>
          We do not share data with advertising networks, data brokers, or social media platforms.
        </p>

        <h2>8. International transfers</h2>
        <p>
          Memry is a small indie operation. Our infrastructure is global by default — encrypted
          blobs may be served from data centers near you for performance. Where personal data
          crosses borders, we rely on standard contractual clauses with our sub-processors.
        </p>

        <h2>9. How long we keep things</h2>
        <ul>
          <li>
            <strong>Encrypted blobs:</strong> kept while your subscription is active. After a lapse,
            kept in read-only mode for 30 days, then in cold storage until day 90, then physically
            deleted.
          </li>
          <li>
            <strong>Account record:</strong> kept while your account exists. If you delete your
            account, the record and any remaining blobs are removed within 30 days.
          </li>
          <li>
            <strong>Billing records:</strong> retained as required by tax law in your country
            (typically 7 years).
          </li>
          <li>
            <strong>Server logs:</strong> retained for up to 30 days for security and debugging.
          </li>
        </ul>

        <h2>10. Your rights</h2>
        <p>
          Depending on where you live (GDPR, UK GDPR, CCPA, and similar laws), you have the right
          to:
        </p>
        <ul>
          <li>Access the personal data we hold about you.</li>
          <li>Correct inaccurate data.</li>
          <li>Delete your account and associated data.</li>
          <li>Export the metadata we hold about your account.</li>
          <li>Object to processing or restrict it in specific cases.</li>
        </ul>
        <p>
          To exercise any of these rights, email{' '}
          <a href="mailto:privacy@memrynote.com">privacy@memrynote.com</a> from the address tied to
          your account. We respond within 30 days.
        </p>
        <p>
          You can also lodge a complaint with your local data protection authority. We would rather
          hear from you first, but you do not have to.
        </p>

        <h2>11. Children</h2>
        <p>
          Memry is not designed for children under 13 (or under 16 in jurisdictions that require
          it). We do not knowingly collect data from children. If you believe a child has signed up,
          email <a href="mailto:privacy@memrynote.com">privacy@memrynote.com</a> and we will delete
          the account.
        </p>

        <h2>12. Security incidents</h2>
        <p>
          If we discover an incident that affects your data, we will notify you within 72 hours of
          confirming the impact. Because content is end-to-end encrypted, the most likely incident
          types are metadata exposure, billing data exposure, or account-takeover attempts — we will
          tell you exactly what was affected.
        </p>

        <h2>13. Changes to this policy</h2>
        <p>
          We will update this page when our practices change. Material changes will be announced in
          the app and via email at least 14 days before they take effect.
        </p>

        <h2>14. Contact</h2>
        <p>
          Privacy questions: <a href="mailto:privacy@memrynote.com">privacy@memrynote.com</a>.
          Anything else: <a href="mailto:hi@memrynote.com">hi@memrynote.com</a>.
        </p>
      </LegalLayout>
    </>
  )
}

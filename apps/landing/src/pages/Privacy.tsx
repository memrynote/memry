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
          <li>Your notes, tasks, and journal stay on your device. We never see their content.</li>
          <li>
            Sync uploads only ciphertext. Every byte is encrypted on your device with
            XChaCha20-Poly1305 before it leaves.
          </li>
          <li>Encryption keys live in your password manager and never touch our servers.</li>
          <li>
            Anonymous usage metrics are optional, on by default, and switchable from Settings →
            Privacy. They never include note content, search queries, file paths, emails, or raw
            IDs.
          </li>
          <li>We collect the minimum metadata needed to bill, deliver, and secure the service.</li>
          <li>We never sell your data. We have nothing to sell.</li>
        </ul>

        <h2>1. What this policy covers</h2>
        <p>
          This policy describes how Memry handles personal data in the desktop app, the marketing
          website, and the optional Sync service. It applies to everyone who uses Memry, regardless
          of country.
        </p>

        <h2>2. The local app keeps your content on your device</h2>
        <p>
          The Memry desktop application runs entirely on your computer. Your notes, tasks, journal,
          and files are stored as plain Markdown files in a vault folder you choose. None of that
          content is sent to us, period.
        </p>
        <p>
          Optional update checks contact our update server, which sees only your IP address and app
          version.
        </p>

        <h2>3. Optional anonymous usage metrics</h2>
        <p>
          Memry includes an optional, anonymous telemetry stream so we can understand which features
          get used, where the app crashes, and where it slows down. You can turn it off at any time
          in <strong>Settings → Privacy → Share Anonymous Usage Metrics</strong>. It is on by
          default in production builds and off in development builds.
        </p>
        <p>
          Each event is one row from a fixed list — for example <em>app_started</em>,{' '}
          <em>note_created</em>, <em>search_performed</em>, <em>sync_run_completed</em>,{' '}
          <em>app_error_seen</em>. We do not capture free-form strings. The schema rejects any
          dimension that looks like an email address, URL, file path, or raw identifier before the
          event ever leaves your device.
        </p>
        <p>Each event ships with:</p>
        <ul>
          <li>The event name and a short action label (both from a fixed enum).</li>
          <li>
            An anonymous install ID and session ID. The install ID is a random UUID generated on
            your device — it is not derived from your hardware, account, or any personal data.
          </li>
          <li>
            App version, release channel, OS platform, CPU architecture, locale, and your timezone
            offset.
          </li>
          <li>Whether you are signed in to Sync (yes/no/unknown) and whether Sync is enabled.</li>
          <li>
            Optional numeric metrics for the action — duration, item count, byte count, retry count.
          </li>
        </ul>
        <p>
          Events are batched in memory and uploaded to{' '}
          <code>sync.memrynote.com/telemetry/batch</code> at most every 30 seconds. We never log
          your IP address against your telemetry stream beyond the standard edge access logs that
          every web server keeps for a short window.
        </p>
        <p>
          Crash reporting is part of the same stream. We see that an error happened, on which
          surface, and an error code from a fixed list — never a stack trace that could contain your
          data.
        </p>

        <h2>4. What Sync sends to our servers</h2>
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

        <h2>5. What the website collects</h2>
        <p>
          Memrynote.com uses minimal, privacy-respecting analytics to understand how people find the
          site and which pages are useful. We do not use third-party advertising trackers and do not
          sell visitor data.
        </p>
        <p>
          If you join the waitlist or contact us, we store the email address you submit so we can
          reply or send the messages you opted into.
        </p>

        <h2>6. How we use the data we have</h2>
        <p>We use the data described above only to:</p>
        <ul>
          <li>Operate, sync, and secure your account.</li>
          <li>Bill you, through Paddle, for the plan you chose.</li>
          <li>
            Send transactional email (sign-up confirmation, payment receipts, security notices).
          </li>
          <li>
            Understand which features get used and where the app crashes (if you have left anonymous
            usage metrics on).
          </li>
          <li>Investigate abuse and comply with legal obligations.</li>
        </ul>
        <p>
          We do not use your data to train models, build advertising profiles, or sell anything to
          anyone.
        </p>

        <h2>7. Encryption details</h2>
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

        <h2>8. Sub-processors</h2>
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

        <h2>9. International transfers</h2>
        <p>
          Memry is a small indie operation. Our infrastructure is global by default — encrypted
          blobs may be served from data centers near you for performance. Where personal data
          crosses borders, we rely on standard contractual clauses with our sub-processors.
        </p>

        <h2>10. How long we keep things</h2>
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
            <strong>Anonymous usage metrics:</strong> aggregated and retained for up to 24 months,
            then deleted. There is no way to tie an event back to a person.
          </li>
          <li>
            <strong>Server logs:</strong> retained for up to 30 days for security and debugging.
          </li>
        </ul>

        <h2>11. Your rights</h2>
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

        <h2>12. Children</h2>
        <p>
          Memry is not designed for children under 13 (or under 16 in jurisdictions that require
          it). We do not knowingly collect data from children. If you believe a child has signed up,
          email <a href="mailto:privacy@memrynote.com">privacy@memrynote.com</a> and we will delete
          the account.
        </p>

        <h2>13. Security incidents</h2>
        <p>
          If we discover an incident that affects your data, we will notify you within 72 hours of
          confirming the impact. Because content is end-to-end encrypted, the most likely incident
          types are metadata exposure, billing data exposure, or account-takeover attempts — we will
          tell you exactly what was affected.
        </p>

        <h2>14. Changes to this policy</h2>
        <p>
          We will update this page when our practices change. Material changes will be announced in
          the app and via email at least 14 days before they take effect.
        </p>

        <h2>15. Contact</h2>
        <p>
          Privacy questions: <a href="mailto:privacy@memrynote.com">privacy@memrynote.com</a>.
          Anything else: <a href="mailto:hi@memrynote.com">hi@memrynote.com</a>.
        </p>
      </LegalLayout>
    </>
  )
}

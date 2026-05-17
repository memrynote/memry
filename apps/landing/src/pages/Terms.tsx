import { LegalLayout } from '@/components/shared/LegalLayout'
import { PageHead } from '@/components/shared/PageHead'

export function TermsPage() {
  return (
    <>
      <PageHead page="terms" />
      <LegalLayout
        eyebrow="Legal · Terms"
        title="Terms of Service"
        intro="The agreement between you and memrynote when you use our local app and Sync service."
        lastUpdated="May 9, 2026"
      >
        <h2>1. Who we are</h2>
        <p>
          memrynote (&ldquo;memrynote,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
          &ldquo;our&rdquo;) is an indie productivity app made up of a free local-first desktop
          application and an optional paid Sync service. By downloading the desktop app or signing
          up for Sync, you agree to these Terms of Service.
        </p>
        <p>
          If you do not agree, do not use the service. These Terms form a binding contract between
          you and the operators of memrynote.
        </p>

        <h2>2. The local app</h2>
        <p>
          The memrynote desktop app is free to download and use, with no account required. Your data
          stays on your device as plain Markdown files in a vault folder you choose. We do not
          monitor, collect, or transmit the contents of your vault.
        </p>
        <p>
          You may use the local app for personal or commercial purposes. You may not redistribute,
          resell, or rebrand the app without written permission.
        </p>

        <h2>3. The Sync service</h2>
        <p>
          Sync is a paid, optional service that copies the encrypted contents of your vault between
          your devices. You retain full ownership of everything you sync. We hold encrypted blobs on
          your behalf and provide the infrastructure to move them between your devices.
        </p>
        <p>
          By creating a Sync account you confirm that you are at least 13 years old (or the age of
          digital consent in your country) and that the contact information you provide is accurate.
        </p>

        <h3>What we provide</h3>
        <ul>
          <li>End-to-end encrypted storage of your vault, scoped to the limits of your plan.</li>
          <li>API and client software to push and pull encrypted updates between your devices.</li>
          <li>Reasonable-effort uptime, backups of encrypted blobs, and security updates.</li>
        </ul>

        <h3>What we do not provide</h3>
        <ul>
          <li>
            Access to the plaintext of your data. Encryption keys never leave your devices, so we
            cannot recover or reset them.
          </li>
          <li>
            Guaranteed uptime, real-time response, or specific recovery times. Sync is sold as-is.
          </li>
        </ul>

        <h2>4. Your account</h2>
        <p>
          You are responsible for keeping your password, recovery key, and any device unlock codes
          safe. If you lose them, we cannot recover your data — that is the trade-off for end-to-end
          encryption.
        </p>
        <p>
          You agree not to share your account, attempt to circumvent plan limits, or use Sync to
          store data on behalf of users who do not have their own account with us.
        </p>

        <h2>5. Acceptable use</h2>
        <p>You agree not to use memrynote to:</p>
        <ul>
          <li>Store, distribute, or sync content that is illegal where you live.</li>
          <li>
            Distribute malware, spyware, or content designed to harm other people&apos;s devices.
          </li>
          <li>
            Run automated tooling that materially degrades the service for other users (excessive
            request volume, exploiting endpoints outside their documented purpose).
          </li>
          <li>
            Reverse-engineer the Sync service to discover keys, decrypt other users&apos; data, or
            impersonate other accounts.
          </li>
        </ul>
        <p>
          We may suspend accounts that violate these rules. Because we cannot read your data, any
          such action is based on metadata, billing signals, or external reports.
        </p>

        <h2>6. Billing</h2>
        <p>
          Sync is billed through Paddle, our merchant of record. Paddle handles payment processing,
          VAT, GST, and US sales tax in your country. The price you see at checkout is the price you
          pay.
        </p>
        <p>
          Plans renew automatically at the end of each billing period until you cancel. You can
          cancel at any time inside the app — your plan stays active until the end of the period you
          have already paid for.
        </p>

        <h2>7. What happens if billing lapses</h2>
        <p>
          If your card fails or you cancel, Sync follows a predictable lapse policy designed to give
          you time to recover without losing data:
        </p>
        <ul>
          <li>
            <strong>Days 0–14 (Grace):</strong> Sync keeps working while you fix the card or change
            your mind.
          </li>
          <li>
            <strong>Days 14–44 (Read-only):</strong> Pulls keep working, pushes are blocked. Pull
            everything to local at your pace.
          </li>
          <li>
            <strong>Day 44 (Purged status):</strong> The server returns 402 Payment Required on
            every request. Encrypted blobs sit untouched.
          </li>
          <li>
            <strong>Day 90 (Blob deletion):</strong> Encrypted blobs are physically removed.
            Recovery from our side ends here.
          </li>
        </ul>

        <h2>8. Refunds</h2>
        <p>
          We offer a 7-day money-back guarantee on every plan, including Believer. See the{' '}
          <a href="/refund">refund policy</a> for the full details on how to request one.
        </p>

        <h2>9. Pricing changes</h2>
        <p>
          We may change pricing for new sign-ups at any time. Existing subscribers keep their
          current price for at least 12 months from the change. Lifetime Believer pricing applies
          for the lifetime of the service to anyone who has paid.
        </p>

        <h2>10. Service changes and termination</h2>
        <p>
          memrynote is pre-1.0 and evolving quickly. We may add, change, or remove features as the
          product matures. Material removals to paid features will be announced at least 30 days in
          advance, and you are welcome to a pro-rated refund of unused time if a removal materially
          changes your plan.
        </p>
        <p>
          You may stop using memrynote at any time. We may terminate or suspend access if you
          violate these Terms. If we shut Sync down entirely we will give at least 90 days&apos;
          notice and provide a path to download your encrypted blobs.
        </p>

        <h2>11. Intellectual property</h2>
        <p>
          You own everything you put into memrynote. We claim no rights over your notes, journal,
          tasks, or files. The memrynote name, branding, and the source code of the proprietary
          parts of the service remain ours; open-source components are licensed under their
          respective licenses.
        </p>

        <h2>12. Disclaimers</h2>
        <p>
          memrynote and Sync are provided &ldquo;as is&rdquo; without warranty of any kind. We do
          our best to keep your encrypted data safe and accessible, but we cannot guarantee
          uninterrupted service, perfect data integrity, or recovery from every failure mode. You
          are responsible for keeping your own backups of vaults that matter to you.
        </p>

        <h2>13. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, our aggregate liability for any claim arising from
          your use of memrynote is limited to the amount you paid us in the 12 months before the
          claim, or USD $100 if you are a free user. We are not liable for indirect, consequential,
          or incidental damages.
        </p>

        <h2>14. Changes to these Terms</h2>
        <p>
          We may update these Terms when the product changes or the law requires it. Material
          changes will be announced in the app and on this page at least 14 days before they take
          effect. Continuing to use memrynote after that date counts as acceptance.
        </p>

        <h2>15. Contact</h2>
        <p>
          Questions, complaints, or a legal notice? Email{' '}
          <a href="mailto:hi@memrynote.com">hi@memrynote.com</a>. We aim to reply within five
          business days.
        </p>
      </LegalLayout>
    </>
  )
}

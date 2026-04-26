# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report them responsibly via one of these channels:

- **Email:** [security@memrynote.com](mailto:security@memrynote.com)
- **GitHub Private Vulnerability Reporting:** [Report a vulnerability](https://github.com/memrynote/memry/security/advisories/new)

Include as much of the following as possible:

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgement:** within 48 hours
- **Initial assessment:** within 5 business days
- **Fix or mitigation:** depends on severity, targeting:
  - Critical: 7 days
  - High: 14 days
  - Medium/Low: next scheduled release

## Scope

The following areas are in scope:

- Encryption and key management (XChaCha20, Ed25519, Argon2id)
- Sync protocol and server communication
- Authentication and session handling
- Local data storage and IPC boundaries
- Desktop shell security for Electron and Tauri (CSP, preload/webview boundaries, command capabilities)

## Out of Scope

- Social engineering attacks
- Denial of service (volumetric)
- Issues in third-party dependencies (report upstream, but let us know)
- Attacks requiring physical access to an unlocked device

## Recognition

We appreciate responsible disclosure. Contributors who report valid vulnerabilities will be credited in release notes (unless they prefer to remain anonymous).

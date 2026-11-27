# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Earlier | No |

Fixes land in the latest 0.1.x release.

## Reporting a vulnerability

Report privately, by either route:

- Email security@conveno.dev.
- Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose
  **Report a vulnerability**.

Do not open a public issue or discussion for a security problem.

Include what you found, how to reproduce it, the commit or version, and what an attacker gains. We
will acknowledge the report, work with you on a fix and a disclosure date, and credit you in the
advisory if you want.

## Scope

In scope (the relay, cryptography and redaction are planned and not in 0.1.x, so reports about
their designs are welcome but cannot yet describe shipped behaviour):

- **Cryptography.** Device keys, pairing, sealed envelopes, signatures, history keys and their use of
  libsodium.
- **The relay.** Anything that lets the relay, or someone who reaches it, read, forge, replay or reorder
  message content, or learn more than account ids, device ids, timestamps and message sizes.
- **Credential handling.** Any path where Conveno reads, stores, logs or forwards a provider login
  token or credential file, or where a secret escapes redaction in `peek`.
- **Prompt injection between agents.** Ways a message from one session can be made to act as an
  instruction from the user, or to trigger spawn, peek or an approval without the owner's consent.
- **Local IPC.** The daemon socket or named pipe, its permissions and the auth token. The token is
  created once, with mode 0600, and kept until the user deletes it.
- **Installers.** `conveno init` and `uninstall` changing files they should not, or failing to
  restore them.

Out of scope: vulnerabilities in the AI CLIs themselves or in their providers (report those to the
vendor), social engineering, and denial of service against a self-hosted relay you run yourself.

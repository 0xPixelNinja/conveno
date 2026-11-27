# Security policy

## Supported versions

Conveno is pre-alpha and nothing is released. Only the `main` branch is supported. Once releases
exist, this section will list the versions that get fixes.

## Reporting a vulnerability

Report privately through GitHub Security Advisories: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue or discussion for a security problem.

Include what you found, how to reproduce it, the commit or version, and what an attacker gains. We
will acknowledge the report, work with you on a fix and a disclosure date, and credit you in the
advisory if you want.

## Scope

In scope:

- **Cryptography.** Device keys, pairing, sealed envelopes, signatures, history keys and their use of
  libsodium.
- **The relay.** Anything that lets the relay, or someone who reaches it, read, forge, replay or reorder
  message content, or learn more than account ids, device ids, timestamps and message sizes.
- **Credential handling.** Any path where Conveno reads, stores, logs or forwards a provider login
  token or credential file, or where a secret escapes redaction in `peek`.
- **Prompt injection between agents.** Ways a message from one session can be made to act as an
  instruction from the user, or to trigger spawn, peek or an approval without the owner's consent.
- **Local IPC.** The daemon socket or named pipe, its permissions and the per-boot token.
- **Installers.** `conveno init` and `uninstall` changing files they should not, or failing to
  restore them.

Out of scope: vulnerabilities in the AI CLIs themselves or in their providers (report those to the
vendor), social engineering, and denial of service against a self-hosted relay you run yourself.

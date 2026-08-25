# Security Policy

## Supported versions

The latest published release is the supported version. Fixes land on `master` and ship in
the next release; older versions are not patched.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

https://github.com/marco-jardim/opencode-model-router/security/advisories/new

Please do not open a public issue for a suspected vulnerability. I will acknowledge the
report and, if it is valid, coordinate a fix and disclosure with you.

## Scope

This plugin intercepts prompts and routes traffic to model providers, so the interesting
classes of bug are:

- Credentials or prompt content leaking into logs, error messages, or snapshots.
- Requests being routed to an unintended provider or endpoint.
- Config loading or override handling that lets untrusted input change routing targets.

Findings in models.dev, opencode itself, or a provider's API belong upstream, but tell me
anyway if the plugin makes them worse.

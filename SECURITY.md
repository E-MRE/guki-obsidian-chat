# Security Policy

## Reporting a vulnerability

Please do not open a public issue, pull request, or discussion for a suspected security
vulnerability. Use GitHub's private vulnerability reporting channel from the repository's
[Security advisories page](https://github.com/E-MRE/guki-obsidian-chat/security/advisories) and
choose **Report a vulnerability**. This is the project's primary security reporting channel.

Include enough detail to reproduce and assess the issue, such as the affected version, operating
system, Obsidian version, relevant configuration, reproduction steps, impact, and a suggested
mitigation if you have one. Redact credentials, tokens, private vault content, and other personal
data. If an attachment is necessary, explain what it contains before sharing it.

GitHub private vulnerability reporting keeps the initial discussion private while the maintainer
investigates and coordinates a fix. Do not disclose the vulnerability publicly until the maintainer
confirms that coordinated disclosure is safe.

## Response process

The maintainer will acknowledge a private report, reproduce or triage it, determine affected
versions, and coordinate a fix or mitigation. A security release is a deliberate decision; fixing
the code does not by itself authorize publication of a new plugin version.

If a report is not accepted as a security issue, the maintainer will explain the reasoning and may
redirect it to a normal issue when doing so is safe.

## Supported versions

The latest published plugin version and the default branch are the primary maintenance targets.
Older versions may receive a fix when the issue is severe and the change can be supported safely.

## Scope

This policy covers the GuKi Chat plugin and the repository's release and build automation. Reports
about Claude Code, Obsidian, or third-party dependencies should be sent to their respective
maintainers as well, while including enough context for GuKi Chat to assess its own impact.

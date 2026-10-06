# Free vs paid

Status: direction agreed in conversation on 2026-09-23, not yet built. Nothing here is
committed work; no slice in [plans/v1.md](plans/v1.md) or [plans/v2.md](plans/v2.md)
depends on it.

## Decision

Open core. The tool a developer runs on their own machine stays free and MIT. A paid tier,
if adoption justifies one, covers what needs coordination across a team.

## Free (MIT, public repo)

- The CLI, the git filter, and the editor overlay (the VS Code extension).
- Published to the VS Code Marketplace, Open VSX (Cursor, Windsurf and VSCodium install
  from it, not from Microsoft's Marketplace), and npm.

Why it stays free and public:

- **Trust.** The product is a git filter that rewrites what developers commit. People will
  not install a closed binary in that path.
- **Visibility.** The public repo, the Marketplace listing, and a launch post are how
  people find it. In year one that is probably worth more than direct sales.
- **Closing the source protects little.** The `.vsix` is bundled JS anyone can unzip, and
  the idea is easy to copy. The defense is being the reference implementation and shipping
  quickly.

## Possible paid team tier

None of these conflict with an MIT core:

- A GitHub App or PR view that shows the stored comments during code review.
- A CI gate that blocks unmarked AI comments (enforcing a "no slop" policy).
- Org-wide settings, and comment storage outside the repo.
- Reports on how much agent context a repository holds.

## Revenue expectation

Direct revenue from a single-developer extension is weak. The Marketplace has no paid
listings, and GitHub Sponsors income is usually small. The most likely payoff is indirect
(consulting, a job, credibility), plus a team tier if adoption takes off.

## Constraints on distribution

- Microsoft's Private Marketplace needs GitHub Enterprise or Copilot Business/Enterprise,
  so it suits internal company tools, not public sales.
- A closed-source public Marketplace listing is allowed but, per above, protects little.

## Positioning (from the same discussion)

Marketplace search matches display name, short description and up to 30 keywords. As of
2026-09-23 the closest competitor, HumanEye, had 2 installs, and the deslop tools delete
agent comments where this one keeps them for the next agent ("deslop without deleting").
Suggested display name pattern: `<Brand>: Hide AI Comments, Keep Agent Context`. The
naming candidates and availability checks are in [design.md](design.md) near the
`slopstash` entry.

## Open questions

- When to start a paid tier: after a first Marketplace release and some adoption signal.
- Whether the paid pieces live in a separate private repo or behind a license key.

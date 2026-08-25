# Contributing to Awesome Cursor Plugins

Thanks for adding to this list. PRs get a reply, always, usually within a week. A closed PR with a
clear reason is a fine outcome; silence is not.

## What gets in

A plugin is listed when all four hold:

1. **It installs.** There is a real install path a reader can follow. For a marketplace listing
   that is the `/add-plugin <name>` line off its own page on `cursor.com/marketplace`. For anything
   else, a concrete command or an install link that works.
2. **There is substance behind it.** A public repository with a real manifest, a README, and
   something the reader can run. Commercial is fine, and most of this list is commercial. A
   sign-up wall with nothing public behind it is not.
3. **The description says plainly what is free and what is paid.** No burying it.
4. **It is not already listed**, and the category is the right one.

Rejections are for: a dead link, no substance, spam, or a duplicate. Nothing else. A competing
plugin is never turned down to protect another entry.

## Entry format

Copy this shape exactly. The generator reads this page, so a malformed entry drops out of
`CATALOG.md` silently.

```markdown
- **Short benefit phrase, what it does for the reader** with [plugin-name](https://github.com/owner/repo) by [Publisher](https://publisher.example). One factual line about what it actually is. 1,234★, MIT.
  Also packaged for Claude Code and Codex · OAuth sign-in.

  <details>
  <summary>Install</summary>

  ```text
  /add-plugin plugin-name
  ```

  </details>
```

- **The benefit phrase leads.** Not the product name, not the category.
- **Facts follow the links**: star count from the GitHub API, SPDX license id, both as of the last
  pass. Do not hand-type a star count you did not fetch.
- **The second line is derived, not written.** Read the two rules below before setting it.
- Entries are alphabetical inside a category only where no better order exists; most categories
  here lead with the most useful.
- No tags, no emoji in entries, no legends.

## The two derived columns

These are the reason this list exists, so they hold to a stricter rule than the prose.

**Portability.** `Also packaged for X` means the plugin's own source repository contains that
client's manifest, at the plugin's path: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`.github/plugin/plugin.json`, `.grok-plugin/plugin.json`, and so on. A root `plugin.json` means it
conforms to the Agent Plugins standard. Nothing here is taken from a vendor's marketing copy, and a
client with no manifest is never claimed. If a repository ships a manifest namespace this list does
not know yet, add the row to `CLIENTS` in `.github/scripts/build-catalog.mjs` with the client it
belongs to, and say in the PR how you established that.

**Sign-in.** `OAuth sign-in` means an unauthenticated MCP `initialize` returned 401 with
protected-resource metadata that resolves. `Paste a token` means the handshake was rejected without
one, or the config declares a key header. `No sign-in` means the server answered unauthenticated,
or the plugin is skills only, or it runs locally. `Points at your own instance` means the endpoint
in the config is a template. If you cannot establish it, say `Sign-in not established` rather than
guessing: an honest gap is worth more than a confident wrong answer.

## Adding a whole category

Open an issue first. A category with two entries in it is usually better merged into a neighbour,
and an empty category never ships with a sample entry in it. An honest empty state or nothing.

## Entries from ZeroPointRepo

Some entries in this list are built by ZeroPointRepo. They are held to the four rules above and to
three more:

- Never more than one of ours in a category.
- A higher bar than a contributor's: no working install path, no listing, regardless of who built it.
- A competing entry is never rejected, reordered, or trimmed to make room for one of ours.

The list has to be useful with every one of those entries deleted. That is the test.

## Reporting something broken

Open an issue with the entry name and what happened. Broken links, a plugin that was pulled from
the marketplace, a portability row that no longer matches the repository, a sign-in column that
changed: all of it is worth an issue, and the weekly run does not catch everything.

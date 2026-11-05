# Agent instructions

## Agent skills

### Issue tracker

Issues and specs live as Markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single root glossary and `docs/adr/`. See `docs/agents/domain.md`.

## Desktop packaging and releases

Before any versioned desktop package build or release:

1. Inspect the changes since the previous release tag, including the intended uncommitted changes. Write Chinese release notes in `docs/releases/desktop-v<version>.md`; use the template in `docs/releases/README.md`.
2. Show the notes to the user **before committing release changes or pushing a tag**. Include the version, target environment and API URL, changes, installation, backend/migration requirements, actual verification results, and known limitations. Mark anything not verified as unverified; do not turn plans or expectations into results.
3. Wait for explicit approval of the displayed notes. A request to "package" or "release" is not approval of notes the user has not seen. If the version, environment, or substantive notes change afterward, show the revision and confirm again.
4. After approval, validate the notes with `node desktop/scripts/check-release-notes.mjs <version>`, commit the reviewed code and notes together, and only then push the requested tag or start the requested manual build. The file must be present in the exact commit being built.
5. GitHub Release must use that checked-in file, not a generic download template. CI checks the document, not the conversation: never invent an approval field or claim CI proves user approval.

Ordinary commit-only requests do not authorize packaging, tags, or deployment. Never move existing release tags or deploy to a server without explicit authorization. Manual `Release` runs also require a version and notes, but only produce build artifacts, never a GitHub Release.

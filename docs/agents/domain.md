# Domain Docs

This repository uses a single domain context.

## Before exploring

- Read `GLOSSARY.md` at the repository root when it exists.
- Read relevant decisions under `docs/adr/` when that directory exists.
- Use the glossary's canonical terms in specs, tickets, tests, and implementation notes.

## Layout

```text
/
├── GLOSSARY.md
└── docs/
    └── adr/
```

Create `GLOSSARY.md` lazily when a term is resolved during domain modeling. Create an ADR only for a hard-to-reverse, surprising decision that reflects a real trade-off.


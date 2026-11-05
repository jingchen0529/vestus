# Domain Docs

This repository uses a single domain context.

**当前状态：`GLOSSARY.md` 与 `docs/adr/` 都还不存在。** 不要为了找它们浪费时间；等真正定下一个
领域术语或一个难以回退的取舍时再建（见文末「Layout」）。已有的决策记录在 `docs/design/`（按日期）
与 `docs/archive/`（已归档），现行口径看 `README.md` 与 `docs/architecture.md`。

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


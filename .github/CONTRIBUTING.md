# Contributing to Baton

Thank you for contributing to Baton!

## Prerequisites

- **Node.js `>= 24.0.0`** (`node:sqlite` + native TypeScript test imports)
- npm (matching Node 24)
- Git

---

## Repository Structure

```text
src/         Zero-dependency Node.js backend daemon & CLI (bin: baton)
web/         Desktop Web UI (React + Vite)
app/         Mobile & PWA UI (Expo / React Native)
sidecars/    Antigravity bridge sidecar plugin
scripts/     Developer, pairing, autostart, and OSS check utilities
test/        Node test suite (`node --test`)
docs/        Architecture & agent protocol specifications
```

---

## Critical Testing Rule

> **Never invoke `node --test` directly without `--import ./test/setup.js`.**

`test/setup.js` redirects `BATON_DIR` and user config paths to isolated temp directories so tests never mutate a real `~/.baton` directory or live daemon state. Always run tests via:

```bash
# Full backend check (oxlint --deny-warnings + tsc + all Node tests)
npm run check

# End-to-end checks with the compiled desktop and mobile web clients
npm run build
npm run test:e2e

# Individual test file safely
node --test --import ./test/setup.js test/your-file.test.js

# Web UI verification
npm --prefix web run lint
npx --prefix web tsc -b --noEmit

# Mobile / Expo UI verification
npx --prefix app tsc --noEmit -p app/tsconfig.json
npm --prefix app run lint
npm --prefix app test -- --watchAll=false

# Automated OSS hygiene & leak check
npm run oss:check
```

---

## Coding Conventions

- Keep server modules free of external runtime npm dependencies (`package.json` intentionally has zero `dependencies`).
- In `app/src/`, follow the design invariants enforced by Jest (`copy.test.ts`, `dirs.test.ts`, `motion.test.ts`, `touch-target.test.ts`).
- Preserve existing section numbers (`§0`–`§23`) when updating `docs/ops/agent-protocol.md`.
- Write regression tests alongside every bug fix and new API surface.

---

## Pull Request Checklist

- [ ] `npm run check` passes (`0` warnings/errors, all tests green)
- [ ] Both compiled clients pass `npm run test:e2e` against an isolated daemon. Set `BATON_E2E_BROWSER` when Chromium is installed in a custom location.
- [ ] `npm --prefix web run lint && npx --prefix web tsc -b --noEmit` passes (if touching `web/`)
- [ ] `npx --prefix app tsc --noEmit -p app/tsconfig.json && npm --prefix app run lint && npm --prefix app test -- --watchAll=false` passes (if touching `app/`)
- [ ] `npm run oss:check` passes cleanly (no hardcoded personal paths, domains, or tokens)
- [ ] Documentation updated ([`README.md`](../README.md), [`docs/README.zh-CN.md`](../docs/README.zh-CN.md), [`docs/installation.md`](../docs/installation.md), [`CHANGELOG.md`](../CHANGELOG.md)) if user-facing behavior changed

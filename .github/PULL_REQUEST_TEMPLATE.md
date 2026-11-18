## Summary
<!-- Concisely describe what this PR changes and why. -->

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Security hardening / cross-platform fix
- [ ] Documentation / CI

## Verification
- [ ] `npm run check` passes (lint + typecheck + Node tests)
- [ ] `npm --prefix web run lint && npx --prefix web tsc -b --noEmit` (if `web/` touched)
- [ ] `npx --prefix app tsc --noEmit && npm --prefix app run lint && npm --prefix app test -- --watchAll=false` (if `app/` touched)
- [ ] `npm run oss:check` passes cleanly

## Notes for Reviewers
<!-- Call out protocol changes, migration notes, or edge cases verified. -->

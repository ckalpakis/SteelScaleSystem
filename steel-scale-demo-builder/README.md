# Steel Scale Systems — on-demand Demo Builder source package

Prepared for Carson Kalpakis, September 7, 2026.

**Status: first implementation package, not installed or deployed.** The active GitHub connection allowed reads but rejected branch creation with `403 Resource not accessible by integration`. No files were committed, no PR was opened and no live systems were changed.

## What is here

- `overlay/src/demo-engine/`: typed business inputs, generation, bounded homepage research, signed admin forms, private preview, explicit publishing/expiry/archive, guided simulation modules, ROI calculator, engagement routes and 51 unit tests.
- `schema/demo-models.prisma`: additive model definitions with optional prospect linkage.
- `schema/migration.sql`: a review candidate, not an executed/generated migration.
- `apply_to_repo.py`: conservative, dry-run-first source installer. It checks the inspected baseline, refuses changed files and main-branch writes, adds routing/nav/models/scripts/business notes, and does not commit, push, migrate, enable or deploy anything.
- `overlay/docs/`: approved business model, full target specification and integration/release gates.
- `CODEX_IMPLEMENTATION_PROMPT.md`: instructions to apply, finish and validate this in your existing repository.
- `PREVIEW.html`: fictional standalone page preview. It has no database-backed admin workflow or active analytics endpoint.
- `tests/`: actual unit-test results and an optional browser smoke-check script. Browser navigation was blocked during preparation, so no browser pass is claimed.

## The permanent business rule

**A scraped lead does not need a demo.** Create one only when you deliberately choose to—either from entered business information or from an existing prospect. Demos never create or activate production clients. No agency white-label/reseller functionality.

## What is not complete

The included conversation modules are clearly labeled guided simulations, not live Vapi calls or live LLM chat. GBP is reference-only; the website check is a bounded homepage HTML read, not Lighthouse/local-rank analysis. Live AI, advanced enrichment, review modules, sales-prioritization integration and the client portal remain subsequent milestones.

The Express/Prisma adapter has not been fully typechecked against installed/generated dependencies, and no database migration or full repository regression suite has run. The feature is off by default. Follow `overlay/docs/DEMO_ENGINE_ROLLOUT.md` before enabling it.

## Handoff

Place the extracted package in a workspace accessible to your coding session and use `CODEX_IMPLEMENTATION_PROMPT.md` in the `SteelScaleSystem` project. It instructs the coding agent to implement and verify the changes rather than start another planning exercise. Keep the package outside the repository when using the installer's clean-worktree check.

## Validation performed

Strict TypeScript checks passed for the generation/validation, website-fetch helper, form-security, rendering and unit-test files. All 51 unit tests passed. The Express/Prisma route adapter passed a syntax-transpilation check only. Python installer syntax compilation passed. These results do not establish production readiness.

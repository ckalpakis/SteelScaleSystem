# Demo engine — integration and rollout

## Current status

Source package only. No GitHub commit, pull request, database migration, live configuration change or deployment has happened. The active GitHub integration rejected branch creation with HTTP 403. Full repository cloning/dependency installation were unavailable in the authoring environment, and its browser denied both local-file and local-HTTP navigation. Do not report full application or browser tests as passed.

The inspected repository uses Express 5, TypeScript and Prisma 6 with PostgreSQL. Preserve its existing stack and lockfile. Do not upgrade frameworks as part of installing this feature.

## Apply the source safely

1. Put the extracted package outside the repository so it does not dirty the working tree.
2. Inspect existing `AGENTS.md` instructions and preserve all user work. Use the work branch provided by the coding environment, or create `feature/on-demand-demo-builder` when permitted. Never force-push, reset, or discard unrelated changes.
3. From a clean checkout, run the package's dry-run installer:

   ```bash
   python /path/to/steel-scale-demo-builder/apply_to_repo.py /path/to/SteelScaleSystem
   ```

4. Review the planned files. Then add `--apply` to write them on a non-main feature branch. The installer does not commit, push, migrate, enable or deploy anything. It verifies the five relevant baseline Git blob hashes and refuses to overwrite newer edits. If hashes differ, adapt the same scoped changes manually after reading the new files; do not bypass the preflight by replacing hashes or resetting the repository.
5. Review `git diff`. Confirm that ingestion, live SMS, booking destinations and voice webhooks are unchanged. The new admin link is `/admin/demos`.
6. The package changes only scripts in `package.json`, not dependencies. Retain the existing lockfile and confirm your package manager sees no dependency change.

## Dependency / schema validation

Use a development environment with its own PostgreSQL database. Do not point tests or `migrate dev` at production.

```bash
npm ci
npx prisma format
npx prisma validate
npm run prisma:generate
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:demos
```

The authoring environment did not run the entire sequence. Fix any type, lint or format failures before proceeding. Format the touched files according to the repository's existing configuration; do not reformat unrelated source files or downgrade lint rules to hide errors.

The source overlay adds Prisma models but deliberately does not install a migration or run SQL. Generate the migration from the integrated schema in **development**:

```bash
npm run prisma:migrate -- --name on_demand_demo_engine --create-only
```

Inspect the generated SQL. It should create only the new sales-demo enum/tables/indexes/foreign keys. `schema/migration.sql` in the package is a review candidate, not an executed or generated migration. Compare it to the generated result. There should be no destructive change to production client, prospect, call or booking tables. Apply the reviewed migration to the development database and regenerate Prisma Client.

For eventual production, use the repository's `npm run prisma:deploy` process with the committed and reviewed migration, not `migrate dev`, reset or `db push`. Migration deployment and application deployment are separate steps. Keep the feature off until both are validated and separately approved for go-live.

## Feature setup

`DEMO_ENGINE_ENABLED=false` is the default. Set it to `true` only in development/staging after migration. Reuse the existing secure `ADMIN_USERNAME`/`ADMIN_PASSWORD` configuration; do not paste real credentials into issues, commits, documentation or model prompts.

No new paid AI, SMS or voice credentials are required for this first release. Its conversation modules are guided simulations. Do not market them as live AI.

Review infrastructure/proxy log redaction for `/demo/*`, retention, TLS and access controls. The app mounts demo routers before its generic request logger, but that cannot control host/proxy logging. Production TLS is required for credentials and reliable browser APIs.

## Required integration tests (not executed in authoring environment)

Use disposable fixtures and a dedicated test database. Record actual results.

- Feature disabled: both `/admin/demos` and `/demo/*` return 404 without database or provider work.
- Feature enabled but no admin credentials: admin routes fail closed.
- Unauthenticated admin requests cannot list, create, edit, publish or archive.
- Missing, modified, expired, wrong-action and wrong-credential CSRF tokens are rejected.
- Create a standalone demo with only business name/niche. No Client, call, booking, SMS, campaign enrollment or lead record is created.
- Create from a searched prospect. Only the optional link is written, and prefilled fields are editable.
- Repeat the same creation request sequentially and concurrently. Only one demo exists.
- Private preview works without any demo event rows. A public GET alone does not count as an open.
- Public draft/archived/expired/unknown tokens return 404, including event submission.
- Publish requires reviewed confirmation. Verify expiration and optimistic version conflicts.
- Regeneration unpublishes the previous version until renewed review.
- Deleting a linked prospect sets the FK to null; editing the standalone demo still works.
- Insert a private sentinel into notes/phone and assert its absence from public HTML, endpoint responses, events and logs.
- Duplicate event insertion, including concurrency, does not increment the counter twice.
- Disabled-module events, invalid event kinds, invalid UUIDs, oversized JSON and cross-origin browser event posts are rejected.
- Concurrent events cannot exceed the 5,000-event lifetime cap. Counters and event rows remain consistent after rollback.
- Verify URL handling with a mocked DNS/socket layer: private/reserved IPs, DNS rebinding, cross-domain redirects, HTTPS downgrade, response size, slow response, failed DNS, non-HTML and compressed content fail safely.
- Start a genuine import/enrichment/scoring operation against fixture data. It must create zero demos and perform zero demo research/provider calls.
- Existing missed-call, Vapi booking, chatbot booking, routing, admin and daily-summary smoke tests still pass against safe fixtures.

## Required browser checks (not executed successfully here)

Check creation, selected/recommended modules, errors preserving entries via Back, manual and linked creation, review, publishing, expiry, archive, private preview and public events in the actual Express application. Test mobile layout and keyboard navigation. Validate the calculator's invalid/blank/percentage inputs and arithmetic. Confirm the visible labels always distinguish simulations from live integrations.

`PREVIEW.html` is a generated, fictional public-page preview. It has no server-backed persistence or active analytics endpoint. It is not a deployed demo. A Playwright smoke-check example is included under `tests/`; run it in an environment that permits browser navigation and uses an available Chromium executable.

## Tested here

- Strict TypeScript checks for `core.ts`, `security.ts`, `website.ts`, `views.ts` and their unit tests.
- 51 unit tests passed (see `tests/unit-results.txt` in the package).
- Syntax transpilation of `routes.ts` only — not integration typechecking with generated Prisma/Express types.
- Python syntax compilation of the installer.

No PostgreSQL migration, full app startup, provider connectivity, full regression run, production code path or browser interaction has been verified. The feature must remain disabled until the missing gates pass.

## Rollback

Before enabling the new feature, use normal backup and migration review procedures. The immediate runtime rollback is `DEMO_ENGINE_ENABLED=false` plus restart/redeploy; it blocks new public/admin demo access without touching production clients. Do not drop tables or delete prospects as an automatic rollback. Reverting code should be a reviewed commit; preserve demo records until their retention/deletion policy is decided.

## References checked during preparation

Prisma 6's official migration documentation distinguishes development `migrate dev` from production `migrate deploy`; deployment does not generate Prisma Client. Consult the repository's pinned Prisma 6 documentation rather than applying Prisma 7 configuration examples.

- Prisma 6 development/production: `https://docs.prisma.io/docs/orm/v6/prisma-migrate/workflows/development-and-production`
- OpenAI project guidance/context behavior: `https://openai.com/index/unrolling-the-codex-agent-loop/`

These references support the workflow guidance, not proof that the local integration was executed.

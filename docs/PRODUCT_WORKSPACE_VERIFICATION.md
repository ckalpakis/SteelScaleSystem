# Product workspace verification

Local verification on September 8, 2026. Production data, Railway settings,
credentials and live-delivery configuration were not changed. All pre-existing
uncommitted platform work was preserved. This increment adds no database schema
or migration, dependency, background timer or provider integration.

## Results

- All **46 regression commands** passed: existing booking, missed-call, chatbot,
  admin, lead-intelligence, GHL availability, demos, workforce, CRM, events,
  integrations, agents, builder, Recovery, knowledge, communications, deployment,
  and the new workspace suites. Provider credentials are blanked by the runner;
  communication is dry-run/stubbed and paid model calls are disabled.
- **2 new unit tests** cover allowlisted window/queue filters, malformed query
  values, salesperson defaults and currency minor-unit formatting.
- **8 new database/API tests** cover member CRM create/update/stage-change flows,
  audit persistence, CSRF, foreign IDs/tenant paths, optimistic conflicts,
  viewer restrictions, integration-only credentials, revoked credentials, stale
  principals, current knowledge, exact-version simulations, changed versions,
  oldest-first assigned/unassigned handoffs, currency/date/evidence exclusions,
  feature flags, unknown/failed/dead deliveries, escaped names and no message-body
  exposure, plus brand-new organization empty states without automatic setup.
  The final empty-state test was also run after the full regression pass.
- Browser suites passed for **workspace, existing operator CRM, Recovery,
  Business Knowledge, Agent Builder and Integrations**. The new workspace suite
  checks filter preservation, reporting windows, navigation into a handoff,
  member CRM creation and notes, keyboard focus, desktop/mobile layout and no
  horizontal page overflow. No page errors, model calls or live sends occurred.
- Lint, typecheck, production build and whitespace checks passed. Existing 30
  migrations applied successfully to a new local empty test database.

## Environment and evidence

Database: `steel_scale_demo_workspace_test` on loopback PostgreSQL port 54331,
inside the already-existing local test container. No existing database was reset
or deleted. Test fixtures are fictional and remain in that disposable database.

The in-app browser bootstrap failed with a host sandbox metadata error before
opening a page. Verification therefore used the repository's existing isolated
Playwright approach and its already-installed Chromium headless-shell. The
Recovery harness initially could not locate its browser; setting the existing
`PLAYWRIGHT_BROWSERS_PATH` resolved that without a download or code change.

Final workspace screenshots are in the local temporary directory:

`/var/folders/6g/s7q848wd6gg2lxf34qbqbks40000gn/T/steel-scale-workspace-browser-AU9Fgv`

Files: `today-desktop.png`, `today-mobile.png`, `results-desktop.png`,
`member-crm-desktop.png`, `member-crm-mobile.png`. Desktop and mobile screenshots
were visually inspected. A cramped organization/back-link layout on mobile was
corrected and rechecked in the final browser run. Existing Steel Scale typography,
colors and components were retained; no visual rebrand or decorative chart was
introduced.

## Repeat locally

Use `NODE_ENV=test`, `DOTENV_CONFIG_PATH=/dev/null`, and an explicit loopback
`DATABASE_URL` whose database name matches `steel_scale_demo_*test`. All database
and browser scripts enforce this disposable-database guard. Never target production.

```sh
npm run prisma:deploy
npm run test:workspace
npm run test:workspace:integration
npm run test:workspace:browser
npm run test:regressions
npm run lint
npm run typecheck
npm run build
```

Set `CHROME_PATH` for the workspace browser harness, or point
`PLAYWRIGHT_BROWSERS_PATH` at the local Playwright browser cache. Do not enable a
worker or delivery provider for these UI checks. See
[PRODUCT_WORKSPACE.md](PRODUCT_WORKSPACE.md) for financial definitions, access
boundaries and remaining commercial priorities.

## Not claimed

No production deployment, customer pilot, provider certification, production load
test, measured customer ROI, complete accessibility certification, new identity
provider, self-service signup, live notifications or finished guided Recovery
configuration is claimed. Those require their own scoped implementation and
staging acceptance checks.

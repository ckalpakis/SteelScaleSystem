# Codex execution prompt — Steel Scale on-demand demo engine

Work in the existing `ckalpakis/SteelScaleSystem` repository. This is an implementation task, not a request for another generic proposal.

Read the existing applicable `AGENTS.md` instructions, `memory.md`, package scripts, current Prisma schema, app routing, admin authentication, HTML layout, and this package's `overlay/docs/STEEL_SCALE_DEMO_ENGINE.md` and `overlay/docs/DEMO_ENGINE_ROLLOUT.md`.

The attached/extracted package is a first source implementation, not a production-ready completion. It was prepared against commit `e9ff23049fa34db1977b295ea2eb3d0f61bc45a5`. GitHub write permission was blocked in the preparation chat, so no repository files were changed there. Some pure modules passed strict TypeScript checks and 51 unit tests, but full app/Prisma/database/browser integration still needs to be done here.

## Business requirement to preserve

Build Steel Scale's own on-demand personalized Demo Builder. Only explicit operator actions may generate demos. Do not attach generation to scraping, ingestion, enrichment, scoring, outreach, contact imports or lifecycle automation. Allow both manual entry and creation from an existing prospect. Allow a demo with no prospect and no production Client. Exclude all agency reseller and white-label features.

Inputs: business name, niche, optional website and GBP reference, location, services, hours, contact reference, private sales notes and selected/recommended modules. Notes must never appear on public pages. Unknown facts stay unknown. Draft generation must be followed by operator review and explicit publishing.

## Execute this first milestone

1. Inspect the worktree and preserve user changes. Work on a dedicated feature/work branch according to this environment's instructions. Never force-push, rewrite history, reset the working tree or modify production settings.
2. Read the supplied source. Apply the safe installer in dry-run mode first if its baseline matches. If the source has evolved, adapt the scoped diff manually after inspecting it; do not override the hash checks, revert newer user work, or install blindly.
3. Integrate `src/demo-engine/*`, the optional `ProspectBusiness` relation, Prisma models, the admin navigation link, feature flag and router mount. Add the business-direction addendum to `memory.md` without replacing existing guidance. Preserve the existing Express/TypeScript/PostgreSQL stack. Do not introduce a second frontend framework or new paid dependency for this milestone.
4. Generate and review a non-destructive Prisma migration against a separate development database. Do not run `migrate dev`, reset, or `db push` on production. Generate Prisma Client and fix any actual integration type errors.
5. Run full typecheck, lint, formatting checks, build, demo unit tests, browser tests and relevant regression tests. Add and run real route/database tests for every release gate in `DEMO_ENGINE_ROLLOUT.md`, including idempotency, concurrency, CSRF, invalid requests, notes leakage, optional/deleted prospect linking, draft/expiry/archive access, event cap, and no demo creation during import/scoring. Do not substitute mocked success for real integration validation.
6. Keep every demonstration clearly labeled. The current receptionist, chatbot, missed-call and nurture modules are guided simulations, not connected live AI. Do not remove these labels to make the release appear more complete.
7. Keep `DEMO_ENGINE_ENABLED=false` in committed defaults. Enable only in a disposable local/staging environment for tests. Do not touch live Twilio, Vapi, Zapier, GHL, customer calendars, customer messages or owner alerts. Do not create fake production clients.
8. Provide an exact file-change summary, commands run and actual outcomes, migration summary, how to open `/admin/demos`, a screenshot when browser execution is available, and remaining gaps. Open a reviewable pull request when this environment is authorized to write. Do not merge or deploy automatically.

## Next substantive milestone after the first milestone is verified

Implement genuine sandbox AI chat and browser voice using the existing provider stack, but create an explicit demo-only runtime and tools with no production booking/SMS/calendar capabilities. Do not directly expose the production chatbot controller or booking service. Verify the raw LLM response parsing before reusing provider wrappers.

Use approved public business facts plus versioned niche packs. Keep private sales notes out of provider prompts and tool outputs. Persist demo sessions separately. Add server-enforced session expiry, per-demo/per-session/daily usage caps, concurrency limits, turn/time caps, kill switches and short-lived browser credentials. Do not expose provider secrets. Do not incur real paid calls or messages without operator-authorized testing and limits. Demo bookings must remain simulated and be labeled as such.

The complete product milestones—stronger niche packs, supported GBP and measured audit enrichment, review/local-SEO modules, engagement-to-call-queue integration, reviewed prospect-to-client handoff, and authenticated client portal—are defined in `STEEL_SCALE_DEMO_ENGINE.md`. Do not mark them done merely because their specification or UI placeholder exists. Prioritize tested end-to-end milestones over broad scaffolding.

## Completion report rules

Separate: source implemented; tests actually passed; integrations not tested; features still simulated; feature flag state; whether anything was committed/pushed; whether a PR exists; and whether anything was deployed. Never report this as added to production unless the deployment actually happened. Finish with concrete results, not only a new plan.

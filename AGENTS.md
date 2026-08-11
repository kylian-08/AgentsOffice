# Repository Guidelines

> **AgentsOffice** — a local-first collaboration office for coding agents (Cursor / Codex / Claude Code). Agents register as "employees", get positions (roles), @mention each other, get tasks dispatched by a supervisor, and hand work off via `handoff_task`. All data stays in local SQLite; the product UI and most docs are in Chinese. `README.md` at the root is the authoritative product document (features, install matrix, MCP tool list).

## Project Structure & Module Organization

This pnpm workspace contains a local-first collaboration office for coding agents. Keep changes within the owning package:

- `apps/hub/src/` is the Fastify + `node:sqlite` (Node 22.13+) + SSE + MCP (Streamable HTTP at `/mcp`) + managed-runner backend. Its tests live in `apps/hub/test/`.
- `apps/web/src/` is the React/Vite browser UI; static files belong in `apps/web/public/`. UI copy is Chinese; preserve that.
- `apps/desktop/` packages the Hub and Web apps as the Windows Electron client (reuses a running hub on 4517 or spawns its own; data shared at `~/.agent-office`).
- `packages/protocol/src/` holds shared types, mention parsing, and prompt templates; tests are in `packages/protocol/test/`.
- `hooks/` contains dependency-free integration scripts for Cursor, Codex, Claude, and ZCode (`zcode-hook.mjs`). Stdio-only clients (e.g. WorkBuddy) connect through a thin SDK proxy at `apps/hub/src/mcp/stdio.ts` (compiled to `dist/mcp/stdio.js`; desktop bundles it as `resources/stdio.js`). `scripts/dist.mjs` assembles release artifacts.

Place cross-package contracts in `packages/protocol`; do not duplicate them in consumers.

Notes for orientation: `docs/` holds product screenshots referenced by the README and PRs. `.spec-workflow/` is the Spec Workflow plugin's own template directory (`.spec-workflow/templates/`, overridable via `.spec-workflow/user-templates/`) — boilerplate, not project documentation; leave it alone unless asked.

## Database Schema & Migrations

Hub uses versioned SQLite migrations in `apps/hub/src/domain/migrations.ts`. The
`SCHEMA` constant in `apps/hub/src/domain/store.ts` is the immutable baseline (tables
without evolution columns); every column/data change goes through the `MIGRATIONS`
array, never by editing `SCHEMA`.

To add a column or migrate data:

1. Append a migration to the end of `MIGRATIONS` in `migrations.ts` with a monotonically
   increasing `version` and a one-line `name`.
2. `detect(db)` returns whether the change is already in effect for old databases — reuse
   `hasColumn(db, table, column)` for column additions. Already-existing structures are
   stamped as applied instead of re-executed.
3. `up(db)` performs the actual DDL/DML; it runs inside a transaction and rolls back on
   failure, throwing an error that includes the version and name.
4. Add coverage in `apps/hub/test/migrations.test.ts` (new-db path, old-db partial path,
   data migration, idempotency, and rollback are the established patterns).

Never bump an existing `version` or reorder the array — schema migrations are
append-only. `applyMigrations(db)` runs automatically in the `OfficeStore` constructor,
after the baseline `SCHEMA`.

## Build, Test, and Development Commands

Use Node.js 22.13+ (required — the hub uses built-in `node:sqlite`) and pnpm 9+.

```bash
pnpm install       # install workspace dependencies
pnpm build         # build all packages in dependency order (protocol → hub → web)
pnpm test          # run all workspace test scripts (vitest)
pnpm start         # run the compiled Hub at localhost:4517
pnpm dist          # build + electron-builder package + copy exe to repo root (see below)
```

For focused work, run `pnpm --filter @agent-office/hub test`, `pnpm --filter @agent-office/hub start`, or `pnpm --filter @agent-office/web dev`. Run `pnpm build` after changing shared protocol exports. There is no root-level `dev` script — only the web package has one.

**Setup / user onboarding** (do not edit these config targets ad hoc; the installer manages them with `.bak-时间戳` backups):
```bash
node apps/hub/dist/setup/install.js install                # user-level Cursor/Codex/Claude config
node apps/hub/dist/setup/install.js install --workspace <path>   # optional project-level files
node apps/hub/dist/setup/install.js uninstall --workspace <path>
```

**Release packaging:** `pnpm dist` (i.e. `scripts/dist.mjs`) runs a full build, kills any running `AgentOffice.exe`, cleans `apps/desktop/release/`, packages via electron-builder, and copies the freshly built `AgentOffice.exe` (portable) and `AgentOffice-Setup.exe` (NSIS installer) to the repo root. **Project convention: run `pnpm dist` after any code change so the root exes stay current.** These exes are gitignored; never commit them.

## Coding Style & Naming Conventions

Write TypeScript as ESM and follow the surrounding file's style: two-space indentation, semicolons, double-quoted imports, and explicit types at public boundaries. Use `camelCase` for variables and functions, `PascalCase` for React components and types, and kebab-case filenames such as `shellterm.ts`. Prefer small domain-focused modules under `apps/hub/src/domain/`; keep browser API calls in `apps/web/src/api.ts`.

No repository-wide linter or formatter is configured. Avoid unrelated reformatting and let `tsc` be the baseline style and type check.

## Testing Guidelines

Hub and protocol tests use Vitest. Name files `*.test.ts`, group cases with `describe`, and state behavior in `it` names. Add or update regression coverage for behavior changes, especially persistence, routing, and protocol parsing. Web also runs Vitest (`apps/web/src/operability.test.ts` — pure helpers only); validate interactive UI changes manually and describe the check in the PR.

## Architecture Boundaries & Known Gotchas

- **Security boundary:** the Hub binds only to `127.0.0.1:4517` and has no auth — never change it to listen externally. Managed (托管) agents run in a read-only sandbox by default; select "可写工作区" when creating a desk that must write files. `handoff_task`-spawned successor CLIs use a writable workspace by design.
- **Managed runners:** desks run `codex exec --json`, `claude -p --output-format json`, `@cursor/sdk`, `kimi -p --print`, `qodercli --print`, or `kilo run --auto` (the latter three share `runNonInteractiveCli` in `runners.ts` with defensive output parsing). One desk runs serially; a global gate (default 3, `AGENT_OFFICE_MAX_RUNS` env or `maxConcurrentRuns` config) caps concurrent managed rounds. Changing runner logic lives in `apps/hub/src/domain/runners.ts` (kind→runner routing in `resolveRunnerForKind`); terminal/PTY logic in `domain/shellterm.ts`.
- **Real-time layer:** SSE pushes browser events; MCP tools (`register_agent`, `read_inbox`, `send_message`, `handoff_task`, `get_context`, `read_logs`, `kb_*`, `create_task`/`claim_task`/`update_task`, `publish_brief`) are the agent-facing API surface in `apps/hub/src/mcp/tools.ts`.
- **Client integrations:** ten clients exist — cursor/codex/claude/zcode/workbuddy/opencode/kimi/qoder/kilo/trae (`IntegrationClient` in `packages/protocol`). Cursor/Codex/Claude/ZCode auto-register sessions via zero-dependency hooks (`hooks/*.mjs`) ingested at `/ingest/*` in `apps/hub/src/integrations/ingest.ts`. ZCode is Claude-Code-compatible (`zcode-hook.mjs`, kind `zcode-cli`, SessionStart returns `additionalContext`). Kimi (`kimi-hook.mjs`, `~/.kimi-code/config.toml` `[[hooks]]` + `mcp.json` + `SYSTEM.md` protocol) and Qoder (`qoder-hook.mjs`, `~/.qoder/settings.json` MCP+hooks + `AGENTS.md`) use the same PascalCase event hooks as Claude/Cursor via a shared `handlePascalEventHook`. OpenCode has no classic JSON hooks — a local plugin (`hooks/opencode-plugin.mjs`, copied to `~/.config/opencode/plugins/agent-office.mjs`) reports `session.created`/`session.idle`/`tool.execute.*` to `/ingest/opencode-hook` (kind `opencode-cli`, remote MCP in `~/.config/opencode/opencode.json`). Kilo is an OpenCode fork (remote MCP at `~/.config/kilocode/kilocode.json` + user `AGENTS.md`), Trae is a VS Code fork (MCP at `%APPDATA%\Trae CN\User\mcp.json`), and WorkBuddy is GUI-only (Tencent workbench) — these three have no hooks and register manually (`kind: kilo-cli` / `trae-ide` / `workbuddy-cli`); WorkBuddy connects via the SDK stdio proxy `apps/hub/src/mcp/stdio.ts` (`Server`+`StdioServerTransport` forwarding `tools/list`/`tools/call` to the Hub's HTTP `/mcp` via an internal SDK `Client`, entry `dist/mcp/stdio.js` or `AGENT_OFFICE_STDIO_ENTRY`). Managed kinds exist for kimi/qoder/kilo (web desk form + `resolveRunnerForKind`), so `handoff_task` successors still spawn Codex managed CLIs by default. Install/health/repair wiring lives in `apps/hub/src/setup/` (`install.ts`, `merge.ts`, `status.ts`); onboarding tabs in `apps/web/src/App.tsx`.
- **Hooks are zero-dependency** forwarding scripts (`hooks/*.mjs`) that register sessions and post fallback briefs; install/uninstall wiring and config merging live in `apps/hub/src/setup/` (`merge.ts`, `install.ts`) and are covered by `apps/hub/test/install-paths.test.ts`.
- **Windows-specific:** the desktop client bundles Electron 37; never rely on `window.prompt` in the web UI (Electron doesn't support it — in-app panels are used instead). ConPTY terminals and `taskkill` in `scripts/dist.mjs` are platform-specific.
- **Data lives on disk:** SQLite DB in `~/.agent-office` (and local `data/`, gitignored). `message` table doubles as a durable queue — the hub re-dispatches backlogged unread messages after restart, so don't treat in-memory state as authoritative.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style messages matching history, for example `feat(web): add agent card details`, `fix(launcher): avoid duplicate Hub startup`, or `build: refresh packaging`. Keep each commit focused. PRs should explain user-visible behavior, list verification commands, link related issues, and include screenshots for UI changes. Do not commit generated `dist/`, release executables, local databases, or credentials unless the release task explicitly requires them.

# web-auto — Behaviour Specification

Browser automation framework for HBK (Heleneborgs Båtklubb) accounting workflows,
built on Playwright / TypeScript.

Requirements below are limited to behaviour that is **directly substantiated by
existing source code**. Eighteen rows from the original draft were removed because
their `impl` files (`mcp-generic.ts`, `mcp-server.ts`, `tasks/src/bas-scrape-all.ts`)
do not exist in the repository at the time of this verification pass.

Requirements are grouped by concern: `WA-CDP` (browser connectivity / state),
`WA-DL` (download conflict handling).
Numbering: `01–09` = invariants / state→cue; `10+` = event-driven behaviours.
Cite an ID in code, commits, and reviews to create a traceable link.

---

## State → cue — Browser connectivity

| ID | Requirement | impl | verify |
|---|---|---|---|
| WA-CDP-01 | While `state.json` exists in the storage directory, `launchBrowser` **shall** load cookies and local storage from it when creating a new browser context. | `core/src/browser.ts › launchBrowser` (lines 31-35, `storageState: statePath`) | confirmed |

## Behaviours — Browser connectivity

| ID | Requirement | impl | verify |
|---|---|---|---|
| WA-CDP-10 | When `cleanup()` is called after a browser session, the system **shall** persist cookies and local storage to `state.json` before closing the browser. | `core/src/browser.ts › launchBrowser › cleanup` (lines 42-46) | confirmed |

## Invariants — File download conflict handling

| ID | Requirement | impl | verify |
|---|---|---|---|
| WA-DL-01 | Both `downloadFile` and `downloadUrl` **shall** default `onConflict` to `"rename"` when the caller does not supply a value. | `core/src/download.ts › downloadFile` (line 44), `downloadUrl` (line 75) | confirmed |

## Behaviours — File download conflict handling

| ID | Requirement | impl | verify |
|---|---|---|---|
| WA-DL-10 | When `onConflict` is `"rename"` and the target file already exists, the system **shall** find the first available `"base (N).ext"` path (N = 1, 2, …) and save there. | `core/src/download.ts › resolveFilename` (lines 26-32) | confirmed |
| WA-DL-11 | When `onConflict` is `"skip"` and the target file already exists, `downloadFile` **shall** cancel the Playwright download event and **shall** return `null` rather than saving any bytes. | `core/src/download.ts › resolveFilename` (lines 22-23, returns `""`), `downloadFile` (lines 56-60, cancel + return null) | confirmed |

---

## Appendix (non-normative)

**Browser state directory.** `launchBrowser` defaults to `.browser-state/state.json`
in the process working directory (`DEFAULT_STORAGE_DIR` constant in `core/src/browser.ts`).

**Download conflict modes.** `resolveFilename` in `core/src/download.ts` handles three
modes: `"overwrite"` returns the target path unconditionally, `"rename"` increments an
integer suffix until a free slot is found, `"skip"` returns an empty string which signals
the caller to cancel/skip.

**Files not yet in the repo (as of this verification).** The following were referenced
in the original draft spec but do not exist: `core/src/mcp-generic.ts`,
`core/src/mcp-server.ts`, `tasks/src/bas-scrape-all.ts`. Requirements touching those
files have been removed and should be reinstated once the files are committed.

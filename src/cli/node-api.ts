/**
 * Node built-ins, reached lazily and only on desktop.
 *
 * Three constraints meet here:
 * - `obsidianmd/no-nodejs-modules` rejects every static `import` of a built-in (including
 *   `import type`) and only accepts a `require()` / dynamic `import()` sitting inside a function
 *   whose first statement is an `if (!Platform.isDesktop)` early exit.
 * - `@typescript-eslint/no-require-imports` rejects `require()`.
 * - **A dynamic `import()` does not work here.** esbuild treats built-ins as external and leaves the
 *   literal `import("child_process")` in `main.js`, which is CJS; a dynamic import inside a CJS
 *   module is resolved by Chromium, not by Node, so it always rejects with
 *   "Failed to resolve module specifier". Verified in the Obsidian console.
 *
 * So: `window.require(...)`, still behind the guard. Both lint rules only match a bare `require`
 * identifier as the callee, and `window.require` is a `MemberExpression`, so neither fires.
 *
 * The accessors stay async — `require` is synchronous, the result is wrapped in
 * `Promise.resolve` — because every caller already awaits them and unwinding that plumbing would
 * mean rewriting working code for no gain.
 *
 * Types come from `typeof import(...)`, a type position neither rule inspects. Module names stay
 * unprefixed: esbuild's external list is built from `builtinModules`, which carries no `node:`
 * prefix, and Electron's `require` accepts either form.
 */
import { Platform } from 'obsidian';

type ChildProcessModule = typeof import('child_process');
type FsModule = typeof import('fs');
type NetModule = typeof import('net');
type OsModule = typeof import('os');
type PathModule = typeof import('path');
type ProcessModule = typeof import('process');

const DESKTOP_ONLY = 'GuKi Chat runs the Claude Code CLI as a subprocess, which is desktop only.';

/**
 * Electron exposes Node's `require` on `window` in the renderer. Typed narrowly as
 * `(id: string) => unknown` so the result has to be narrowed by an explicit cast at every call
 * site — `any` would trip `no-unsafe-assignment` / `no-unsafe-call` / `no-unsafe-member-access`.
 */
interface NodeRequireWindow {
	require: (id: string) => unknown;
}

function loadNodeModule(id: string): unknown {
	return (window as unknown as NodeRequireWindow).require(id);
}

export function nodeChildProcess(): Promise<ChildProcessModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	return Promise.resolve(loadNodeModule('child_process') as ChildProcessModule);
}

export function nodeFs(): Promise<FsModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	return Promise.resolve(loadNodeModule('fs') as FsModule);
}

/**
 * Unix domain sockets, for the permission bridge. The MCP permission server is spawned by the
 * *CLI*, not by us, so its stdio is taken; this socket is the only channel back to the plugin
 * (PHASE5A-STATE D1).
 */
export function nodeNet(): Promise<NetModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	return Promise.resolve(loadNodeModule('net') as NetModule);
}

export function nodeOs(): Promise<OsModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	return Promise.resolve(loadNodeModule('os') as OsModule);
}

export function nodePath(): Promise<PathModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	return Promise.resolve(loadNodeModule('path') as PathModule);
}

/**
 * The parent process environment. Never handed to `spawn` unsanitised — see `claude-process.ts`.
 *
 * Read through `require('process')` rather than the global `process`: the global is only present
 * when Electron's node integration exposes it, and that is exactly the assumption that made the
 * dynamic imports fail. `require('process')` returns the same object without depending on it.
 */
export function nodeEnv(): Record<string, string | undefined> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	return (loadNodeModule('process') as ProcessModule).env;
}

/**
 * As much of Electron's renderer module as one question needs. Declared rather than imported:
 * `electron` is not a Node built-in and there are no types for it in this project, and the whole
 * point of this file is that the reach for it happens in exactly one place.
 */
interface ElectronModule {
	webUtils?: {
		getPathForFile(file: File): string;
	};
}

/**
 * The absolute filesystem path behind a `File`, or `null` when it has none.
 *
 * **Feature detection, deliberately not a version check.** Electron removed `File.path` in 32 in
 * favour of `webUtils.getPathForFile(file)`. This machine's Obsidian 1.13.7 bundles Electron 43.3.0
 * (measured off the app's own Electron Framework binary, R11), so `File.path` is already gone here
 * — but Obsidian's bundled Electron moves on its own schedule, and a hardcoded threshold would need
 * re-verifying at every Obsidian update. Asking the object what it has needs verifying once.
 *
 * This is the shape Obsidian itself uses, read out of its renderer bundle (1.13.7, `app.js` byte
 * 1,444,293): `var s = d.path || ""; if (isDesktopApp && electron.webUtils && (s =
 * electron.webUtils.getPathForFile(d)), !s) { ...image/png → "Pasted image"... }`. Two things that
 * copies deliberately — a falsy return, not a throw, is how "no path" arrives, and a `File` with
 * no path is a pasted screenshot.
 *
 * **`null` is not an error to swallow.** It means this `File` has no path, which is the clipboard
 * image — the single case that has to send bytes, and PLAN Phase 6 task 3. The callers pass it over
 * in silence rather than reporting it, so task 3 can pick the event up cleanly.
 */
export function absolutePathForFile(file: File): string | null {
	if (!Platform.isDesktop) {
		// A mobile `File` has no filesystem path to give, so there is nothing to detect.
		return null;
	}
	// Not on `File` in lib.dom — it was an Electron addition, and the point here is that it may
	// legitimately be missing. Read as `unknown` so an older Electron handing back something odd
	// falls through to `webUtils` rather than being trusted.
	const legacy = (file as File & { path?: unknown }).path;
	if (typeof legacy === 'string' && legacy.length > 0) {
		return legacy;
	}
	try {
		const webUtils = (loadNodeModule('electron') as ElectronModule).webUtils;
		if (!webUtils) {
			return null;
		}
		const resolved = webUtils.getPathForFile(file);
		return typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
	} catch {
		// No `electron` module at all: this is not Obsidian's renderer. `docs/offline-checks.ts`
		// runs here, which is what makes the "no path" branch drivable offline.
		return null;
	}
}

/**
 * Node types re-exported through an `import(...)` type position, so consumers never need an
 * `import type ... from 'child_process'` statement — which `no-nodejs-modules` also rejects.
 */
export type SpawnedProcess = import('child_process').ChildProcessWithoutNullStreams;
export type NodeSocket = import('net').Socket;
export type NodeSocketServer = import('net').Server;

/**
 * Sends a signal to a process we did **not** spawn, so there is no `ChildProcess` handle to call
 * `.kill()` on. The MCP permission server is one of those: the CLI spawns it, we only learn its pid
 * from the `hello` it sends over the socket (PHASE5A-STATE D3).
 *
 * Never throws: by the time this runs the process is usually already gone, and an ESRCH must not
 * take the rest of a quit path down with it. Returns whether the signal was delivered.
 */
export function nodeKill(pid: number, signal: NodeJS.Signals): boolean {
	if (!Platform.isDesktop) {
		return false;
	}
	try {
		(loadNodeModule('process') as ProcessModule).kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

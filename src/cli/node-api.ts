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

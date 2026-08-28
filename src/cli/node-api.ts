/**
 * Node built-ins, reached lazily and only on desktop.
 *
 * Two lint rules meet here and both have to be satisfied:
 * - `obsidianmd/no-nodejs-modules` rejects every static `import` of a built-in (including
 *   `import type`) and only accepts a dynamic `import()` / `require()` sitting inside a function
 *   whose first statement is an `if (!Platform.isDesktop)` early exit.
 * - `@typescript-eslint/no-require-imports` rejects `require()`.
 *
 * So: dynamic `import()` behind the guard. That makes every accessor async, which is why
 * `ClaudeProcess.start()` is async — the modules are loaded once, cached, and every later call
 * resolves from cache. Module names stay unprefixed: esbuild's external list is built from
 * `builtinModules`, which does not carry the `node:` prefix.
 *
 * The types come from `typeof import(...)`, a type position neither rule inspects.
 */
import { Platform } from 'obsidian';

type ChildProcessModule = typeof import('child_process');
type FsModule = typeof import('fs');
type OsModule = typeof import('os');
type PathModule = typeof import('path');

const DESKTOP_ONLY = 'GuKi Chat runs the Claude Code CLI as a subprocess, which is desktop only.';

let childProcessModule: Promise<ChildProcessModule> | null = null;
let fsModule: Promise<FsModule> | null = null;
let osModule: Promise<OsModule> | null = null;
let pathModule: Promise<PathModule> | null = null;

export function nodeChildProcess(): Promise<ChildProcessModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	childProcessModule ??= import('child_process');
	return childProcessModule;
}

export function nodeFs(): Promise<FsModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	fsModule ??= import('fs');
	return fsModule;
}

export function nodeOs(): Promise<OsModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	osModule ??= import('os');
	return osModule;
}

export function nodePath(): Promise<PathModule> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	pathModule ??= import('path');
	return pathModule;
}

/** The parent process environment. Never handed to `spawn` unsanitised — see `claude-process.ts`. */
export function nodeEnv(): Record<string, string | undefined> {
	if (!Platform.isDesktop) {
		throw new Error(DESKTOP_ONLY);
	}
	return process.env;
}

/**
 * Node types re-exported through an `import(...)` type position, so consumers never need an
 * `import type ... from 'child_process'` statement — which `no-nodejs-modules` also rejects.
 */
export type SpawnedProcess = import('child_process').ChildProcessWithoutNullStreams;

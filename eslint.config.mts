import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		// The MCP permission server and its build copy. It is a standalone Node script the *CLI*
		// spawns in its own process, not plugin code: it is outside `tsconfig`, it uses Node
		// globals the browser config does not define, and `obsidianmd/no-nodejs-modules` would
		// reject the `node:net` import that is the whole point of it. Same treatment as the
		// `docs/` harnesses — and, like them, it only proves itself when it is actually run, so
		// `docs/offline-checks.ts` §K spawns the real process over a real socket.
		'mcp-permission-server.mjs',
		'src/cli/mcp-permission-server.mjs',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		// Phase 0 spike harnesses: standalone scripts, not part of the plugin build.
		'docs',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
);

// Minimal stand-in so `docs/phase3-offline-checks.ts` can bundle for node. The production code
// under test only uses these two from `obsidian` as values (the `instanceof` check on the vault
// adapter); everything else it imports is type-only and erased at build time.
export class App {}
export class FileSystemAdapter {}
// `session-manager` pulls in `binary-resolver` → `node-api`, which imports Platform as a value.
// Nothing in these checks calls it; the stub only has to exist for the bundle to link.
export const Platform = { isDesktop: true };

// Phase 6: `attachment-resolver.ts` checks `instanceof TFile` on whatever Obsidian's drag state
// hands back, and `instanceof FileSystemAdapter` before it trusts a path. Both have to be real
// classes here, not shapes, or the guard under test would answer "no" for every input and §O would
// pass by refusing everything.
export class TFile {}

// Phase 5: `permission-broker.ts` imports `normalizePath` as a value. Obsidian's own version
// collapses duplicate slashes and strips a leading one; the broker only ever builds a
// `.obsidian/plugins/...` path, so the identity of a well-formed path is all these checks need —
// and §K asserts on the exact string the broker asks the adapter for.
export function normalizePath(path) {
	return path.replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

// §L drives `tool-card.ts`'s two display-string functions directly, which pulls the whole module
// — and its `setIcon` import — into the bundle. Only the two pure functions are called; the icon
// helper exists so the module links, and touching the DOM here would mean the checks were testing
// rendering rather than the decision.
export function setIcon() {}

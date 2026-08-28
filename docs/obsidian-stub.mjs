// Minimal stand-in so `docs/phase3-offline-checks.ts` can bundle for node. The production code
// under test only uses these two from `obsidian` as values (the `instanceof` check on the vault
// adapter); everything else it imports is type-only and erased at build time.
export class App {}
export class FileSystemAdapter {}
// `session-manager` pulls in `binary-resolver` → `node-api`, which imports Platform as a value.
// Nothing in these checks calls it; the stub only has to exist for the bundle to link.
export const Platform = { isDesktop: true };

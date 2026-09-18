/** esbuild's `.mjs` → `text` loader (see esbuild.config.mjs): the import resolves to a string. */
declare module '*.mjs' {
	const content: string;
	export default content;
}

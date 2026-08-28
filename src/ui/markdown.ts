/**
 * Wrapper around Obsidian's own markdown renderer, so assistant content gets vault typography:
 * code blocks, callouts and wikilinks all look the way they do in a note.
 */
import { MarkdownRenderer, type App, type Component } from 'obsidian';

/**
 * `sourcePath` is the note a link would be resolved from. The chat is not a note, so the vault
 * root is used — an empty path — which resolves `[[wikilinks]]` against the vault as a whole.
 */
const CHAT_SOURCE_PATH = '';

/**
 * Renders markdown into `el`, replacing whatever was there.
 *
 * `component` must be the view, never the plugin (`obsidianmd/no-plugin-as-component`): child
 * components the renderer creates are unloaded with the view, not left until the plugin is
 * disabled. Signature verified at obsidian.d.ts:4013.
 */
export async function renderChatMarkdown(
	app: App,
	markdown: string,
	el: HTMLElement,
	component: Component,
): Promise<void> {
	el.empty();
	await MarkdownRenderer.render(app, markdown, el, CHAT_SOURCE_PATH, component);
}

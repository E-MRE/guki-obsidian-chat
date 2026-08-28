import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_GUKI_CHAT } from './constants';
import { ChatView } from './ui/chat-view';

export default class GukiChatPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE_GUKI_CHAT, (leaf) => new ChatView(leaf));

		this.addCommand({
			id: 'open-chat',
			// Obsidian already prefixes the palette entry with "GuKi Chat: ".
			name: 'Open chat',
			// No default hotkey by design; the command palette is the only entry point.
			callback: () => {
				void this.activateView();
			},
		});

		// Opening a leaf before the layout is ready puts it in the wrong place.
		this.app.workspace.onLayoutReady(() => {
			void this.activateView();
		});
	}

	// No onunload leaf teardown on purpose: unregistering the view type is enough for
	// Obsidian to clear the leaf, while detachLeavesOfType would also destroy wherever
	// the user had moved the panel, on every reload (obsidianmd/detach-leaves).

	/** Reveals the existing chat leaf, or creates a pinned one in the main area. */
	private async activateView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_GUKI_CHAT);
		let leaf: WorkspaceLeaf | undefined = existing[0];

		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({
				type: VIEW_TYPE_GUKI_CHAT,
				active: true,
				pinned: true,
			});
		}

		await workspace.revealLeaf(leaf);
	}
}

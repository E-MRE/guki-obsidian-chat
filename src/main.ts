import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_GUKI_CHAT } from './constants';
import { ChatView } from './ui/chat-view';

export default class GukiChatPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE_GUKI_CHAT, (leaf) => new ChatView(leaf));

		this.addCommand({
			id: 'open-chat',
			name: 'Open GuKi Chat',
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

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_GUKI_CHAT);
	}

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

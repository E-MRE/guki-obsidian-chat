import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_GUKI_CHAT } from './constants';
import { SessionManager } from './core/session-manager';
import { ChatView } from './ui/chat-view';

export default class GukiChatPlugin extends Plugin {
	private session: SessionManager | null = null;

	async onload(): Promise<void> {
		// The session outlives any single view; the view only subscribes to its state.
		const session = new SessionManager(this.app);
		this.session = session;

		this.registerView(VIEW_TYPE_GUKI_CHAT, (leaf) => new ChatView(leaf, session));

		// Obsidian's quit path does not guarantee onunload, and a surviving subprocess would
		// outlive the app (RESEARCH C). Both routes call dispose(), which is idempotent.
		this.registerEvent(
			this.app.workspace.on('quit', () => {
				session.dispose();
			}),
		);

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

	onunload(): void {
		// The subprocess is not covered by Component.register* — kill it by hand.
		this.session?.dispose();
		this.session = null;
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
			});
		}

		// Pin explicitly, on every path. ViewState.pinned does not actually apply the
		// pin (verified by hand 2026-08-28), and a leaf restored from the saved layout
		// never goes through setViewState at all.
		leaf.setPinned(true);

		await workspace.revealLeaf(leaf);
	}
}

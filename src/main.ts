import * as Obsidian from 'obsidian';
import { Plugin, WorkspaceLeaf } from 'obsidian';
import { CHAT_VIEW_ICON, CHAT_VIEW_TITLE, VIEW_TYPE_GUKI_CHAT } from './constants';
import { SessionManager } from './core/session-manager';
import { normalizePermissionSettings } from './core/permission-policy';
import { ConversationTitleStore } from './data/conversation-titles';
import { PromptHistoryStore } from './data/prompt-history';
import { DEFAULT_SEND_KEY } from './core/send-key';
import { ChatView } from './ui/chat-view';
import { DEFAULT_SETTINGS, GukiSettingTab, type GukiChatSettings } from './ui/settings-tab';
import { getLocale, setLocale, t, type Lang } from './i18n';

const OPEN_CHAT_COMMAND_ID = 'open-chat';

export default class GukiChatPlugin extends Plugin {
	private session: SessionManager | null = null;
	private titleStore: ConversationTitleStore | null = null;
	private automaticLocale: Lang = 'en';
	settings: GukiChatSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.applyLanguageSetting(true);

		const titleStore = new ConversationTitleStore(
			this.settings.conversationTitles,
			async (map) => {
				this.settings = {
					...this.settings,
					conversationTitles: map,
				};
				await this.saveData(this.settings);
			},
		);
		this.titleStore = titleStore;
		const promptHistory = new PromptHistoryStore(
			this.settings.promptHistory,
			async (list) => {
				this.settings = {
					...this.settings,
					promptHistory: list,
				};
				await this.saveData(this.settings);
			},
		);

		// The session outlives any single view; the view only subscribes to its state.
		const session = new SessionManager(
			this.app,
			this.settings.claudeBinaryPath,
			this.settings,
			this.settings.slashCommands ?? [],
		);
		session.setOnSaveSettings(async (newPermissions) => {
			const permissions = newPermissions ?? session.getPermissionSettings();
			this.settings = {
				...this.settings,
				rememberedDecisions: [...permissions.rememberedDecisions],
			};
			await this.saveSettings();
		});
		session.setOnSlashCommandsUpdated(async (commands) => {
			this.settings = {
				...this.settings,
				slashCommands: [...commands],
			};
			await this.saveData(this.settings);
		});
		this.session = session;

		this.addSettingTab(new GukiSettingTab(this.app, this));

		this.registerView(
			VIEW_TYPE_GUKI_CHAT,
			this.createChatViewFactory(session, titleStore, promptHistory),
		);

		this.addRibbonIcon(CHAT_VIEW_ICON, CHAT_VIEW_TITLE, () => {
			void this.activateView();
		});

		// Obsidian's quit path does not guarantee onunload, and a surviving subprocess would
		// outlive the app (RESEARCH C). Both routes call dispose(), which is idempotent.
		this.registerEvent(
			this.app.workspace.on('quit', () => {
				session.dispose();
			}),
		);

		// Opening a leaf before the layout is ready puts it in the wrong place.
		this.app.workspace.onLayoutReady(() => {
			void this.activateView();
		});
	}

	createChatViewFactory(
		session: SessionManager,
		titleStore?: ConversationTitleStore,
		promptHistory?: PromptHistoryStore,
	): (leaf: WorkspaceLeaf) => ChatView {
		return (leaf) => new ChatView(
			leaf,
			session,
			undefined,
			titleStore,
			promptHistory,
			() => this.settings.sendKey ?? DEFAULT_SEND_KEY,
		);
	}

	onunload(): void {
		// The subprocess is not covered by Component.register* — kill it by hand.
		this.session?.dispose();
		this.session = null;
	}

	private async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<GukiChatSettings> | null;
		const permissions = normalizePermissionSettings(data);
		this.settings = {
			...DEFAULT_SETTINGS,
			...(data ?? {}),
			...permissions,
			slashCommands: Array.isArray(data?.slashCommands)
				? data.slashCommands.filter((s): s is string => typeof s === 'string')
				: [],
			promptHistory: Array.isArray(data?.promptHistory)
				? data.promptHistory.filter((s): s is string => typeof s === 'string')
				: [],
			conversationTitles: typeof data?.conversationTitles === 'object' && data?.conversationTitles !== null && !Array.isArray(data?.conversationTitles)
				? data.conversationTitles
				: {},
			sendKey: data?.sendKey === 'mod-enter' ? 'mod-enter' : DEFAULT_SEND_KEY,
			language: data?.language === 'en' || data?.language === 'tr' ? data.language : 'auto',
		};
	}

	/** Called by the settings tab on every change; the open composer placeholder updates immediately. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.session?.setClaudeBinaryOverride(this.settings.claudeBinaryPath);
		this.session?.setPermissionSettings(this.settings);
		await this.applyLanguageSetting();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GUKI_CHAT)) {
			if (leaf.view instanceof ChatView) {
				leaf.view.refreshComposerPlaceholder();
			}
		}
	}

	/** The one production door for initial locale setup and live language changes. */
	private async applyLanguageSetting(initialize = false): Promise<void> {
		if (initialize) {
			const languageKey: keyof typeof Obsidian = 'getLanguage';
			const getLanguage = Obsidian[languageKey] as (() => string) | undefined;
			// ponytail: Obsidian has no public language-change event, so automatic language is
			// sampled at plugin load and remains fixed until the plugin is loaded again.
			this.automaticLocale = getLanguage?.() === 'tr' ? 'tr' : 'en';
		}

		const configured = this.settings.language;
		const effective: Lang = configured === 'en' || configured === 'tr'
			? configured
			: this.automaticLocale;
		const changed = getLocale() !== effective;
		setLocale(effective);

		if (changed) {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GUKI_CHAT)) {
				if (!(leaf.view instanceof ChatView)) {
					continue;
				}
				const viewState = leaf.getViewState();
				const draft = leaf.view.captureDraft();
				await leaf.setViewState({ type: 'empty' });
				await leaf.setViewState(viewState);
				if (leaf.view instanceof ChatView) {
					leaf.view.restoreDraft(draft);
				}
			}
		}

		if (initialize || changed) {
			if (typeof this.removeCommand === 'function') {
				this.removeCommand(OPEN_CHAT_COMMAND_ID);
			}
			this.addCommand({
				id: OPEN_CHAT_COMMAND_ID,
				// Obsidian already prefixes the palette entry with "GuKi Chat: ".
				name: t('host.command.openChat'),
				// No default hotkey by design; the command palette is the only entry point.
				callback: () => {
					void this.activateView();
				},
			});
		}
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
			// The right sidebar, not a main-area tab: the panel's narrow layout
			// (`NARROW_BREAKPOINT_PX`) is built for this width, and a sidebar leaf
			// doesn't compete with note tabs the way a main-area one does.
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
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

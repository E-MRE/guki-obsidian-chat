/**
 * Single field: the Claude Code binary path. Empty means "resolve automatically"
 * (`resolveClaudeBinary`'s normal search order, RESEARCH C).
 */
import { App, PluginSettingTab, Setting } from 'obsidian';
import {
	DEFAULT_PERMISSION_SETTINGS,
	type CategorySetting,
	type PermissionSettings,
	type RememberedDecision,
} from '../core/permission-policy';
import { DEFAULT_SEND_KEY, type SendKeyMode } from '../core/send-key';
import type { ConversationTitleMap } from '../data/conversation-titles';
import type GukiChatPlugin from '../main';

export interface GukiChatSettings extends PermissionSettings {
	claudeBinaryPath: string;
	sendKey?: SendKeyMode;
	slashCommands?: string[];
	conversationTitles?: ConversationTitleMap;
	promptHistory?: string[];
}

export const DEFAULT_SETTINGS: GukiChatSettings = {
	claudeBinaryPath: '',
	sendKey: DEFAULT_SEND_KEY,
	slashCommands: [],
	promptHistory: [],
	...DEFAULT_PERMISSION_SETTINGS,
};

export function formatRememberedDecision(d: RememberedDecision): { title: string; detail: string } {
	if (d.category === 'command') {
		const rawCmd = d.argv ? d.argv.join(' ') : (d.description ?? 'Command');
		const cwd = d.cwd ? `Directory: ${d.cwd}` : '';
		return {
			title: `Bash: ${rawCmd}`,
			detail: cwd,
		};
	}
	if (d.category === 'write') {
		const rawPath = d.path ?? 'unknown path';
		const state = typeof d.existedOnGrant === 'boolean'
			? ` (${d.existedOnGrant ? 'existing file' : 'new file'})`
			: '';
		return {
			title: `Write: ${rawPath}`,
			detail: `File write${state}`,
		};
	}
	const rawPath = d.path ?? 'unknown path';
	return {
		title: `Read: ${rawPath}`,
		detail: 'File or directory read',
	};
}

export function removeRememberedDecision(settings: PermissionSettings, id: string): boolean {
	const idx = settings.rememberedDecisions.findIndex((d) => d.id === id);
	if (idx === -1) {
		return false;
	}
	settings.rememberedDecisions.splice(idx, 1);
	return true;
}

export function clearRememberedDecisions(settings: PermissionSettings): void {
	settings.rememberedDecisions = [];
}

export class GukiSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: GukiChatPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Claude code binary path')
			.setDesc(
				'Leave empty to find it automatically. Only takes effect on the next chat session ' +
					'start — a session already running keeps using the binary it started with.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Found automatically')
					.setValue(this.plugin.settings.claudeBinaryPath)
					.onChange(async (value) => {
						const trimmed = value.trim();
						this.plugin.settings.claudeBinaryPath = trimmed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Send message with')
			.setDesc('Cmd/Ctrl+Enter avoids sending by accident when you paste a multi-line note; Enter then inserts a new line.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('enter', 'Enter')
					.addOption('mod-enter', 'Cmd/Ctrl+Enter')
					.setValue(this.plugin.settings.sendKey ?? DEFAULT_SEND_KEY)
					.onChange(async (value) => {
						this.plugin.settings.sendKey = value as SendKeyMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setHeading().setName('Permissions outside the vault');

		new Setting(containerEl)
			.setName('Read outside the vault')
			.setDesc('Reading files or listing directories located outside the vault.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('always ask', 'Always ask')
					.addOption('auto-allow', 'Auto-allow')
					.setValue(this.plugin.settings.readOutsideVault)
					.onChange(async (value) => {
						this.plugin.settings.readOutsideVault = value as CategorySetting;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Write outside the vault')
			.setDesc('Creating or editing files located outside the vault.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('always ask', 'Always ask')
					.addOption('auto-allow', 'Auto-allow')
					.setValue(this.plugin.settings.writeOutsideVault)
					.onChange(async (value) => {
						this.plugin.settings.writeOutsideVault = value as CategorySetting;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Run commands')
			.setDesc('Executing shell commands via bash.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('always ask', 'Always ask')
					.addOption('auto-allow', 'Auto-allow')
					.setValue(this.plugin.settings.runCommands)
					.onChange(async (value) => {
						this.plugin.settings.runCommands = value as CategorySetting;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setHeading().setName('Allow everything mode');

		new Setting(containerEl)
			.setName('Allow everything (high risk)')
			.setDesc(
				`Automatically allows every request without prompting, except writes into ${this.app.vault.configDir}/ ` +
					'and malformed requests. Danger: the model can read, write, and execute commands ' +
					'anywhere on your system without your approval.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.allowEverything)
					.onChange(async (value) => {
						this.plugin.settings.allowEverything = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setHeading().setName('Remembered permissions');

		const listContainer = containerEl.createDiv({ cls: 'guki-remembered-list' });
		this.renderRememberedList(listContainer);
	}

	private renderRememberedList(container: HTMLElement): void {
		container.empty();

		const decisions = this.plugin.settings.rememberedDecisions;

		const headerSetting = new Setting(container)
			.setName('Stored decisions')
			.setDesc(
				decisions.length === 0
					? 'No remembered permissions. When you approve a request with "don\'t ask again", it will appear here.'
					: `${String(decisions.length)} remembered decision${decisions.length === 1 ? '' : 's'}.`,
			);

		if (decisions.length > 0) {
			headerSetting.addButton((btn) =>
				btn
					.setButtonText('Clear all')
					.setWarning()
					.onClick(async () => {
						clearRememberedDecisions(this.plugin.settings);
						await this.plugin.saveSettings();
						this.renderRememberedList(container);
					}),
			);

			for (const decision of decisions) {
				const { title, detail } = formatRememberedDecision(decision);
				const setting = new Setting(container)
					.setName(title)
					.setDesc(detail);
				if (setting.nameEl) {
					setting.nameEl.title = title;
				}
				if (setting.descEl && detail) {
					setting.descEl.title = detail;
				}
				setting.addButton((btn) =>
					btn
						.setButtonText('Remove')
						.onClick(async () => {
							removeRememberedDecision(this.plugin.settings, decision.id);
							await this.plugin.saveSettings();
							this.renderRememberedList(container);
						}),
				);
			}
		}
	}
}

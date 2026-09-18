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
	type RunCommandsSetting,
} from '../core/permission-policy';
import { DEFAULT_SEND_KEY, type SendKeyMode } from '../core/send-key';
import type { ConversationTitleMap } from '../data/conversation-titles';
import { t } from '../i18n';
import type GukiChatPlugin from '../main';

export interface GukiChatSettings extends PermissionSettings {
	claudeBinaryPath: string;
	sendKey?: SendKeyMode;
	slashCommands?: string[];
	conversationTitles?: ConversationTitleMap;
	promptHistory?: string[];
	language?: 'auto' | 'en' | 'tr';
	/** The context %, 5h and 7d bars in the composer's status line. Off by default — the model name
	 * stays visible either way. */
	showUsageStats?: boolean;
}

export const DEFAULT_SETTINGS: GukiChatSettings = {
	claudeBinaryPath: '',
	sendKey: DEFAULT_SEND_KEY,
	slashCommands: [],
	promptHistory: [],
	language: 'auto',
	showUsageStats: false,
	...DEFAULT_PERMISSION_SETTINGS,
};

export function formatRememberedDecision(d: RememberedDecision): { title: string; detail: string } {
	if (d.category === 'command') {
		const rawCmd = d.argv ? d.argv.join(' ') : (d.description ?? t('settings.remembered.command.fallback'));
		const cwd = d.cwd ? t('settings.remembered.command.detail', { cwd: d.cwd }) : '';
		return {
			title: t('settings.remembered.command.title', { command: rawCmd }),
			detail: cwd,
		};
	}
	if (d.category === 'write') {
		const rawPath = d.path ?? t('settings.remembered.path.unknown');
		const detail = typeof d.existedOnGrant === 'boolean'
			? t(d.existedOnGrant
				? 'settings.remembered.write.detail.existing'
				: 'settings.remembered.write.detail.new')
			: t('settings.remembered.write.detail');
		return {
			title: t('settings.remembered.write.title', { path: rawPath }),
			detail,
		};
	}
	const rawPath = d.path ?? t('settings.remembered.path.unknown');
	return {
		title: t('settings.remembered.read.title', { path: rawPath }),
		detail: t('settings.remembered.read.detail'),
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
			.setName(t('settings.language.name'))
			.setDesc(t('settings.language.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('auto', t('settings.language.option.auto'))
					.addOption('en', t('settings.language.option.en'))
					.addOption('tr', t('settings.language.option.tr'))
					.setValue(this.plugin.settings.language ?? 'auto')
					.onChange(async (value) => {
						this.plugin.settings.language = value === 'en' || value === 'tr' ? value : 'auto';
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName(t('settings.binaryPath.name'))
			.setDesc(t('settings.binaryPath.desc'))
			.addText((text) =>
				text
					.setPlaceholder(t('settings.binaryPath.placeholder'))
					.setValue(this.plugin.settings.claudeBinaryPath)
					.onChange(async (value) => {
						const trimmed = value.trim();
						this.plugin.settings.claudeBinaryPath = trimmed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('settings.sendKey.name'))
			.setDesc(t('settings.sendKey.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('enter', t('settings.sendKey.option.enter'))
					.addOption('mod-enter', t('settings.sendKey.option.modEnter'))
					.setValue(this.plugin.settings.sendKey ?? DEFAULT_SEND_KEY)
					.onChange(async (value) => {
						this.plugin.settings.sendKey = value as SendKeyMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('settings.showUsageStats.name'))
			.setDesc(t('settings.showUsageStats.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showUsageStats ?? false)
					.onChange(async (value) => {
						this.plugin.settings.showUsageStats = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setHeading().setName(t('settings.permissions.heading'));

		new Setting(containerEl)
			.setName(t('settings.permissions.read.name'))
			.setDesc(t('settings.permissions.read.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('always ask', t('settings.permissions.option.alwaysAsk'))
					.addOption('auto-allow', t('settings.permissions.option.autoAllow'))
					.setValue(this.plugin.settings.readOutsideVault)
					.onChange(async (value) => {
						this.plugin.settings.readOutsideVault = value as CategorySetting;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('settings.permissions.write.name'))
			.setDesc(t('settings.permissions.write.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('always ask', t('settings.permissions.option.alwaysAsk'))
					.addOption('auto-allow', t('settings.permissions.option.autoAllow'))
					.setValue(this.plugin.settings.writeOutsideVault)
					.onChange(async (value) => {
						this.plugin.settings.writeOutsideVault = value as CategorySetting;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('settings.permissions.commands.name'))
			.setDesc(t('settings.permissions.commands.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('always ask', t('settings.permissions.option.alwaysAsk'))
					.addOption('auto-allow', t('settings.permissions.option.autoAllow'))
					.addOption('auto-allow-unsafe', t('settings.permissions.option.autoAllowUnsafe'))
					.setValue(this.plugin.settings.runCommands)
					.onChange(async (value) => {
						this.plugin.settings.runCommands = value as RunCommandsSetting;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setHeading().setName(t('settings.allowEverything.heading'));

		new Setting(containerEl)
			.setName(t('settings.allowEverything.name'))
			.setDesc(t('settings.allowEverything.desc', { configDir: this.app.vault.configDir }))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.allowEverything)
					.onChange(async (value) => {
						this.plugin.settings.allowEverything = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setHeading().setName(t('settings.remembered.heading'));

		const listContainer = containerEl.createDiv({ cls: 'guki-remembered-list' });
		this.renderRememberedList(listContainer);
	}

	private renderRememberedList(container: HTMLElement): void {
		container.empty();

		const decisions = this.plugin.settings.rememberedDecisions;

		const headerSetting = new Setting(container)
			.setName(t('settings.remembered.stored.name'))
			.setDesc(
				decisions.length === 0
					? t('settings.remembered.empty')
					: t(decisions.length === 1
						? 'settings.remembered.count.one'
						: 'settings.remembered.count.other', { count: decisions.length }),
			);

		if (decisions.length > 0) {
			headerSetting.addButton((btn) =>
				btn
					.setButtonText(t('settings.remembered.clearAll'))
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
						.setButtonText(t('settings.remembered.remove'))
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

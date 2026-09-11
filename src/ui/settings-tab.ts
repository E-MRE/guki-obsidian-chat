/**
 * Single field: the Claude Code binary path. Empty means "resolve automatically"
 * (`resolveClaudeBinary`'s normal search order, RESEARCH C).
 */
import { App, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_PERMISSION_SETTINGS, type PermissionSettings } from '../core/permission-policy';
import type GukiChatPlugin from '../main';

export interface GukiChatSettings extends PermissionSettings {
	claudeBinaryPath: string;
}

export const DEFAULT_SETTINGS: GukiChatSettings = {
	claudeBinaryPath: '',
	...DEFAULT_PERMISSION_SETTINGS,
};

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
	}
}

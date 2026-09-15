import { chatStrings } from './keys/chat';
import { coreStrings } from './keys/core';
import { settingsStrings } from './keys/settings';
import { transcriptStrings } from './keys/transcript';

export type Lang = 'en' | 'tr';
export type Message = { en: string; tr: string };

const ALL = {
	...settingsStrings,
	...chatStrings,
	...transcriptStrings,
	...coreStrings,
};

type MessageKey = keyof typeof ALL;

let currentLocale: Lang = 'en';

export function setLocale(lang: Lang): void {
	currentLocale = lang;
}

export function getLocale(): Lang {
	return currentLocale;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
	const message: Message = ALL[key];
	return message[currentLocale].replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
		vars && Object.prototype.hasOwnProperty.call(vars, name)
			? String(vars[name])
			: placeholder,
	);
}

export type SendKeyMode = 'enter' | 'mod-enter';

export const DEFAULT_SEND_KEY: SendKeyMode = 'enter';

export function shouldSend(
	mode: SendKeyMode,
	event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
): boolean {
	if (event.key !== 'Enter' || event.shiftKey) {
		return false;
	}
	return mode === 'enter' || event.metaKey || event.ctrlKey;
}

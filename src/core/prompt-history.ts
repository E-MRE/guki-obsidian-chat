/** Maximum number of prompts retained for shell-style composer navigation. */
export const PROMPT_HISTORY_CAP = 100;

/**
 * Appends one prompt to an oldest-first history without mutating the supplied list.
 */
export function appendPromptHistory(list: readonly string[], text: string, cap: number): string[] {
	if (text.trim().length === 0 || list[list.length - 1] === text) {
		return [...list];
	}
	const next = [...list, text];
	return next.length > cap ? next.slice(-cap) : next;
}

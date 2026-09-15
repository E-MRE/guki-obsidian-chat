/** Maximum number of prompts retained for shell-style composer navigation. */
export const PROMPT_HISTORY_CAP = 100;

/**
 * Appends one prompt to an oldest-first history without mutating the supplied list.
 */
export function appendPromptHistory(list: readonly string[], text: string, cap: number): string[] {
	const trimmed = text.trim();
	if (trimmed.length === 0 || list[list.length - 1] === trimmed) {
		return [...list];
	}
	const next = [...list, trimmed];
	return next.length > cap ? next.slice(-cap) : next;
}

import { appendPromptHistory, PROMPT_HISTORY_CAP } from '../core/prompt-history';

/** Persistent, oldest-first prompt history for the composer. */
export class PromptHistoryStore {
	private entries: string[];

	constructor(
		initial: string[] | undefined,
		private readonly save: (list: string[]) => Promise<void>,
	) {
		this.entries = Array.isArray(initial)
			? initial.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
			: [];
	}

	list(): readonly string[] {
		return this.entries;
	}

	async record(text: string): Promise<void> {
		const next = appendPromptHistory(this.entries, text, PROMPT_HISTORY_CAP);
		if (next.length === this.entries.length && next.every((entry, index) => entry === this.entries[index])) {
			return;
		}
		this.entries = next;
		await this.save(this.snapshot());
	}

	snapshot(): string[] {
		return [...this.entries];
	}
}

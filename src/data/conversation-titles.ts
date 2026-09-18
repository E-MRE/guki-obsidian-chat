export interface StoredTitle {
	title: string;
	updatedAt: number;
}

export type ConversationTitleMap = Record<string, StoredTitle>;

export class ConversationTitleStore {
	private readonly titles = new Map<string, StoredTitle>();

	constructor(
		initial: ConversationTitleMap | undefined,
		private readonly save: (map: ConversationTitleMap) => Promise<void>,
	) {
		if (typeof initial === 'object' && initial !== null && !Array.isArray(initial)) {
			for (const [id, entry] of Object.entries(initial)) {
				if (
					typeof entry === 'object' &&
					entry !== null &&
					!Array.isArray(entry) &&
					typeof entry.title === 'string'
				) {
					const trimmed = entry.title.trim();
					if (trimmed.length > 0) {
						this.titles.set(id, {
							title: trimmed,
							updatedAt: typeof entry.updatedAt === 'number'
								? entry.updatedAt
								: Date.now(),
						});
					}
				}
			}
		}
	}

	/** The user-given name, or undefined. Never returns an empty string. */
	get(sessionId: string): string | undefined {
		const entry = this.titles.get(sessionId);
		if (!entry || entry.title.trim().length === 0) {
			return undefined;
		}
		return entry.title;
	}

	/** Empty or whitespace-only title REMOVES the entry (this is the documented undo path). */
	async set(sessionId: string, title: string): Promise<void> {
		const trimmed = title.trim();
		if (trimmed.length === 0) {
			await this.remove(sessionId);
			return;
		}
		this.titles.set(sessionId, {
			title: trimmed,
			updatedAt: Date.now(),
		});
		await this.save(this.snapshot());
	}

	async remove(sessionId: string): Promise<void> {
		const deleted = this.titles.delete(sessionId);
		if (deleted) {
			await this.save(this.snapshot());
		}
	}

	/** Drops entries whose sessionId is not in `existingIds`. Returns true if anything was
	 *  removed. Saves only when something changed. */
	async pruneTo(existingIds: Iterable<string>): Promise<boolean> {
		const allowed = new Set(existingIds);
		let changed = false;
		for (const id of Array.from(this.titles.keys())) {
			if (!allowed.has(id)) {
				this.titles.delete(id);
				changed = true;
			}
		}
		if (changed) {
			await this.save(this.snapshot());
		}
		return changed;
	}

	/** Defensive copy for checks and for persistence.
	 *
	 *  Null-prototype on purpose: a session id is a filename from the CLI's project directory, so
	 *  an id of `__proto__` is possible, and `copy['__proto__'] = entry` on a normal object literal
	 *  sets the prototype instead of an own key — the title would vanish from `Object.keys` and
	 *  from `JSON.stringify`. Checks AR6.10/AR6.11 cover it. */
	snapshot(): ConversationTitleMap {
		const copy: ConversationTitleMap = Object.create(null) as ConversationTitleMap;
		for (const [id, entry] of this.titles) {
			copy[id] = {
				title: entry.title,
				updatedAt: entry.updatedAt,
			};
		}
		return copy;
	}
}

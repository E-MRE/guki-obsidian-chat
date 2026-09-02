/**
 * What an attachment is, and how it reaches the CLI.
 *
 * **We hold a path, not bytes** (PLAN §5 decision 10). A chip carries a file's absolute
 * filesystem path; the CLI fetches the content itself. Nothing here reads a file, so there is no
 * base64, no size ceiling and no format list of ours.
 *
 * Pure on purpose — no `obsidian`, no Node — because the one rule in this file is a security rule
 * and every branch of it has to be drivable from a fixture (`docs/offline-checks.ts` §O). The
 * impure half (a `TFile` to a verified absolute path) is `attachment-resolver.ts`.
 */

/**
 * Which side of the vault boundary the file is on. **This is the discriminant the `@` decision is
 * made from, and it must come from a real resolution** (`VaultPaths.isInside`), never from how the
 * path looks or from where the UI thinks it came.
 *
 * `'outside-vault'` is not reachable from this phase's UI — both affordances resolve vault files —
 * but the rule it selects is written and tested here rather than left implicit, because a two-way
 * rule with only one branch implemented is how the wrong half gets filled in later. The drag,
 * permission and card wiring for it is task 2.
 */
export type AttachmentLocation = 'in-vault' | 'outside-vault';

export interface Attachment {
	/**
	 * The absolute, symlink-resolved path — the same string the permission policy verified. Never
	 * vault-relative: the CLI's cwd is the vault root, so a relative path would resolve, but it
	 * would also resolve *differently* if the cwd ever changed.
	 */
	absolutePath: string;
	/** What the chip shows. The file name, not the path — the chip is narrow. */
	displayName: string;
	location: AttachmentLocation;
}

/**
 * **The quoting is not cosmetic; without it the reference silently expands to nothing.**
 *
 * Measured 2026-09-02, CLI 2.1.258, `-p --input-format stream-json`, with every read tool in
 * `--disallowedTools` so the model had no `Read` to fall back on:
 *
 * | Form                                   | Expanded |
 * |----------------------------------------|----------|
 * | `@/tmp/.../300 Projects/Bare Note.md`  | **no** — `NO_CONTENT`, `permission_denials: []` |
 * | `@/tmp/.../300\ Projects/Escaped\ Note.md` | **no** — backslash is not the mechanism |
 * | `@"/tmp/.../300 Projects/Quoted Note.md"` | **yes** |
 * | `@"/tmp/.../plain/note.md"` (no space)  | **yes** |
 * | `@"/tmp/.../🏰 300 Projects/Vault Note.md"` | **yes** |
 *
 * So `@` mention parsing stops at whitespace, and quoting is what carries it past. Quoting a path
 * with no space in it expands too, which is why this always quotes rather than branching on
 * whether a space is present — one code path, and the branch that would only ever be exercised by
 * spaceless paths cannot rot.
 *
 * This vault makes it the common case, not an edge one: `🏰 300-Projects`, `📥 000-Inbox/Dump`.
 * A bare `@` would have failed on almost every real note while producing no error anywhere — the
 * CLI reports nothing, the model just does not see a file.
 */
const AT_QUOTE = '"';

/**
 * The reference text for one attachment, or `null` when no safe reference can be built.
 *
 * `null` is not an error case to swallow — it means "do not use `@` for this one". The caller
 * falls back to the plain path, which makes the model call `Read` and puts the request through
 * PLAN §2b, where an in-vault read is allowed and anything else raises a card. That is the
 * fail-safe direction: a plain path is checked, an unbalanced `@"…"` is silently empty.
 */
export function attachmentReference(attachment: Attachment): string | null {
	const { absolutePath, location } = attachment;
	if (absolutePath.length === 0) {
		return null;
	}
	// The whole Phase 5b gate for this file, in one line. `@` is expanded client-side before the
	// model sees the message — no `Read`, no tool call, no policy consultation (PLAN's Phase 6
	// syntax table) — so an `@` on a path outside the vault would disable the permission system
	// for it silently. In-vault, the bypass costs nothing because §2b would allow that read anyway.
	if (location !== 'in-vault') {
		return absolutePath;
	}
	// Two characters the quoted form cannot survive, and they fail differently.
	//
	// A double quote closes the quoting early, so the reference expands to nothing — measured,
	// `Emre's "quoted" note.md` did not expand. Backslash-escaping is already known not to be the
	// CLI's mechanism for spaces, so it is not relied on for quotes either.
	//
	// A newline is not separately measured; it follows from the rule the table above *did* measure.
	// `@` parsing stops at whitespace and quoting is what carries it past — but a quoted string
	// cannot carry a line break, so the reference truncates exactly as a bare space did, and the
	// rest of the name lands in the prompt as free-standing text.
	//
	// Both fall back to the plain path, which the model reads through §2b's gate.
	if (/["\n\r]/.test(absolutePath)) {
		return null;
	}
	return `@${AT_QUOTE}${absolutePath}${AT_QUOTE}`;
}

/**
 * Builds the message that actually goes to the CLI.
 *
 * References go on their own lines above the text, mirroring where the chips sit above the
 * textarea. A reference that could not be built as `@` is still included, as a plain path, so an
 * attached file never goes missing from the prompt — it just gets read through the gate.
 */
export function composeMessage(text: string, attachments: readonly Attachment[]): string {
	const references = attachments
		.map((attachment) => attachmentReference(attachment) ?? attachment.absolutePath)
		.filter((reference) => reference.length > 0);

	const trimmed = text.trim();
	if (references.length === 0) {
		return trimmed;
	}
	const head = references.join('\n');
	return trimmed.length === 0 ? head : `${head}\n\n${trimmed}`;
}

/**
 * Whether this message is worth sending. An attachment with no typed text is a real message —
 * "here, look at this" — so the composer's emptiness check cannot be the textarea alone.
 */
export function hasSendableContent(text: string, attachments: readonly Attachment[]): boolean {
	return text.trim().length > 0 || attachments.length > 0;
}

/** Drops a duplicate path, keeping the first. Dragging the same file twice is one chip. */
export function addAttachment(
	existing: readonly Attachment[],
	attachment: Attachment,
): Attachment[] {
	if (existing.some((held) => held.absolutePath === attachment.absolutePath)) {
		return [...existing];
	}
	return [...existing, attachment];
}

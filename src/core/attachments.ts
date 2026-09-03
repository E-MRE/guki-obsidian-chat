/**
 * What an attachment is, and how it reaches the CLI.
 *
 * **Almost everything holds a path, not bytes** (PLAN §5 decision 10). A chip carries a file's
 * absolute filesystem path; the CLI fetches the content itself. There is exactly one exception, and
 * it is the reason this is a union: a **pasted clipboard image** is a bitmap that exists only in
 * memory, so there is no path to send and `Read` has nothing to open. It travels as an `image`
 * base64 content block instead (PLAN Phase 6 task 3, wire format verified in RESEARCH B6).
 *
 * **The union is deliberate, and the alternative was a trap.** `Attachment` used to be identified by
 * `absolutePath` everywhere — `addAttachment` deduped on it, `Composer.detach` filtered on it, and
 * `composeMessage` mapped every attachment through `attachmentReference(a) ?? a.absolutePath`. An
 * image has no path, and the tempting fix is to invent one: `''`, a `blob:` URL, a temp file. Every
 * one of those flows into `composeMessage` and lands in the prompt as free-standing text, and into
 * `attachmentReference`'s `location` check where a bitmap gets classified as in-vault or
 * out-of-vault — one of which is an `@`. Nothing errors. Discriminating on `kind` instead makes the
 * *compiler* ask every consumer what it does with an image, which is the only way a rule with no
 * visible failure mode stays right.
 *
 * Pure on purpose — no `obsidian`, no Node — because the rules in this file are security rules and
 * every branch has to be drivable from a fixture (`docs/offline-checks.ts` §O). The impure half (a
 * `TFile` or a `File` to a verified attachment) is `attachment-resolver.ts`.
 */

/**
 * Which side of the vault boundary the file is on. **This is the discriminant the `@` decision is
 * made from, and it must come from a real resolution** (`VaultPaths.isInside`), never from how the
 * path looks or from where the UI thinks it came.
 */
export type AttachmentLocation = 'in-vault' | 'outside-vault';

/**
 * The image formats an `image` content block may carry.
 *
 * **This is the API's list, not one of ours, and PLAN's "no supported-format list of our own" does
 * not cover it.** That sentence was written about the path case, where `Read` decides what it can
 * open and its own error is the honest place for a failure. When we build the content block
 * ourselves we are the one making the claim, so the claim has to be true.
 *
 * Measured 2026-09-02 (M3), and the reason a gate exists at all: bytes the pipeline cannot decode
 * do **not** fail the turn. They come back `subtype: "success"`, `is_error: false`, as an ordinary
 * assistant bubble in which the model says it could not see the image — a billed round trip with no
 * error state anywhere in the panel. In all three refusals the model named exactly this set,
 * unprompted, which is where the four values below come from.
 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Whether an arbitrary `File.type` string is one the model can actually read. */
export function isImageMediaType(mediaType: string): mediaType is ImageMediaType {
	return (IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/** A file on disk. The payload is its path; the CLI's own `Read` fetches the content. */
export interface PathAttachment {
	kind: 'path';
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
 * A bitmap with no file behind it — a pasted screenshot, or an image dragged out of a web page.
 *
 * It carries its own `id` rather than borrowing a path, because there is nothing about the bytes
 * that identifies them: the clipboard names every screenshot `image.png` (measured, task 2 §R3), so
 * two pasted images would otherwise be indistinguishable to `addAttachment` and to `detach`.
 */
export interface ImageAttachment {
	kind: 'image';
	/** Generated at paste time. The chip list's identity, in place of a path. */
	id: string;
	displayName: string;
	mediaType: ImageMediaType;
	/** Base64, **without** a `data:` prefix — exactly what `source.data` takes (RESEARCH B6). */
	data: string;
	/** Decoded length, for the chip's tooltip. Not a gate: there is no size ceiling (M1). */
	byteLength: number;
}

export type Attachment = PathAttachment | ImageAttachment;

/**
 * What identifies one chip in the composer's list.
 *
 * A path for a file, the generated id for an image. Two pastes of the same screenshot are two
 * chips, deliberately: the bytes carry no identity, and a paste is an explicit act each time —
 * unlike a drag, where the `dragManager` source and the `dataTransfer` fallback can both report the
 * same file and dedupe is what stops a double-add.
 */
export function attachmentKey(attachment: Attachment): string {
	return attachment.kind === 'path' ? attachment.absolutePath : attachment.id;
}

/** The images among a chip list, in order — the ones that become `image` content blocks. */
export function imageAttachments(attachments: readonly Attachment[]): ImageAttachment[] {
	return attachments.filter((attachment): attachment is ImageAttachment => attachment.kind === 'image');
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
 * The reference text for one **path** attachment, or `null` when no safe reference can be built.
 *
 * Narrowed to `PathAttachment` on purpose. An image contributes no text at all, and the question
 * "what is the `@` rule for a bitmap" has no answer — letting one in here would mean inventing a
 * `location` for it. `promptReference` is the exhaustive front door; this is only the `@` rule.
 *
 * `null` is not an error case to swallow — it means "do not use `@` for this one". The caller
 * falls back to the plain path, which makes the model call `Read` and puts the request through
 * PLAN §2b, where an in-vault read is allowed and anything else raises a card. That is the
 * fail-safe direction: a plain path is checked, an unbalanced `@"…"` is silently empty.
 */
export function attachmentReference(attachment: PathAttachment): string | null {
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
 * What one attachment contributes to the **text** of the outgoing message, or `null` for nothing.
 *
 * The exhaustive front door, and the reason the union is worth its cost: the `switch` below is
 * where the compiler makes every future attachment kind answer "what does this put in the prompt".
 *
 * For an image the answer is **nothing, because it travels in its own content block** — not an
 * empty string, not a placeholder, not a filename. Anything else would put text in the prompt that
 * names a file the model cannot open, and the previous shape of this code
 * (`attachmentReference(a) ?? a.absolutePath`) would have read `.length` off an `undefined`
 * `absolutePath` and **thrown inside `SessionManager.send`**.
 */
export function promptReference(attachment: Attachment): string | null {
	switch (attachment.kind) {
		case 'path': {
			// A reference that could not be built as `@` still goes in, as a plain path, so an
			// attached file never goes missing from the prompt — it just gets read through the gate.
			const reference = attachmentReference(attachment) ?? attachment.absolutePath;
			return reference.length > 0 ? reference : null;
		}
		case 'image':
			return null;
	}
}

/**
 * Builds the message text that goes to the CLI.
 *
 * References go on their own lines above the text, mirroring where the chips sit above the
 * textarea.
 *
 * **An image-only message composes to the empty string, and that is correct** — but it means the
 * emptiness test in `SessionManager.send` cannot be `message.length === 0` alone, or an image with
 * no typed text is silently dropped. See that function; `docs/offline-checks.ts` §O7 pins it.
 */
export function composeMessage(text: string, attachments: readonly Attachment[]): string {
	const references = attachments
		.map(promptReference)
		.filter((reference): reference is string => reference !== null);

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

/** Drops a duplicate, keyed by `attachmentKey`. Dragging the same file twice is one chip. */
export function addAttachment(
	existing: readonly Attachment[],
	attachment: Attachment,
): Attachment[] {
	const key = attachmentKey(attachment);
	if (existing.some((held) => attachmentKey(held) === key)) {
		return [...existing];
	}
	return [...existing, attachment];
}

/**
 * Base64 for an `image` block's `source.data`, chunked.
 *
 * **Not `btoa(String.fromCharCode(...bytes))`.** Spreading a typed array into argument position
 * overflows the call stack somewhere in the tens of thousands of elements, and a screenshot is two
 * orders of magnitude past that — task 2's measured paste was 27,878 bytes and a full-display one
 * is megabytes. The chunk size is **divisible by 3**, which is what makes encoding each chunk
 * separately and concatenating the results identical to encoding the whole buffer: base64 maps
 * every 3 input bytes onto 4 output characters, so a chunk boundary off a multiple of 3 would
 * introduce padding in the middle of the string.
 *
 * `btoa` rather than an encoder of our own: it is the platform's, it is correct by construction,
 * and it keeps this file pure — no Node, so `docs/offline-checks.ts` can drive it (§O9 pins it
 * against `Buffer.toString('base64')` across a chunk boundary).
 */
const BASE64_CHUNK_BYTES = 32_766;

export function encodeBase64(bytes: Uint8Array): string {
	let encoded = '';
	for (let at = 0; at < bytes.length; at += BASE64_CHUNK_BYTES) {
		let binary = '';
		for (const byte of bytes.subarray(at, at + BASE64_CHUNK_BYTES)) {
			binary += String.fromCharCode(byte);
		}
		encoded += btoa(binary);
	}
	return encoded;
}

/** The `src` for a chip thumbnail or a transcript preview. The wire never sees this form. */
export function imageDataUrl(attachment: ImageAttachment): string {
	return `data:${attachment.mediaType};base64,${attachment.data}`;
}

/**
 * The chip's tooltip for an image, standing in for the absolute path a file chip shows.
 *
 * Two pasted screenshots are both called `image.png` by the clipboard, so the thumbnail carries the
 * identity and this carries the detail — and their sizes almost always differ.
 */
export function imageSummary(attachment: ImageAttachment): string {
	const kb = attachment.byteLength / 1024;
	const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb)).toString()} KB`;
	return `${attachment.displayName} — ${attachment.mediaType.replace('image/', '').toUpperCase()}, ${size}`;
}

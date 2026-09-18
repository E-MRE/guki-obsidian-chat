/**
 * On-disk transcript record -> ChatItem translator.
 *
 * Translates raw DAG active-branch records into the domain model ChatItem[]
 * (UserItem, AssistantItem, DividerItem, PermissionItem) for historical conversation redraw.
 *
 * Governed by docs/capture-phase8-transcript-schema.md (§3 Mappability Table, §4a-4e):
 * - Per-turn cost: NOT stored on disk; left undefined.
 * - Per-turn duration: ONLY where system/turn_duration links to assistant via parentUuid;
 *   otherwise undefined.
 * - Thinking: block structure survives; stripped text renders as present-but-empty ("").
 *   Non-empty thinking text renders as-is.
 * - Compaction: system/compact_boundary becomes DividerItem with NO segment duration.
 * - Ordinary permissions: absent from disk; tool renders as executed or denied.
 * - Denied tool: identified by child user record carrying toolDenialKind (clears toolIsError).
 * - Cancelled turn: tool_use without tool_result, followed by interruption record (status 'stopped').
 * - AskUserQuestion: partially reconstructed as PermissionItem with one-line answered summary.
 * - Sidecar tool results: offloaded outputs (<persisted-output>) read real file if present,
 *   otherwise fallback to embedded preview. Untouched records are never read.
 */

import { nodeFs, nodeOs, nodePath } from '../cli/node-api';
import { t } from '../i18n';
import type {
	AssistantItem,
	ChatItem,
	DividerItem,
	MessageBlock,
	PermissionItem,
	PermissionStatus,
	UserItem,
} from '../core/chat-state';
import { isImageMediaType, type ImageAttachment, type ImageMediaType } from '../core/attachments';
import {
	parseAskUserQuestionAnswers,
	parseAskUserQuestionInput,
} from '../core/ask-user-question';
import { toolResultText } from '../core/tool-policy';
import type { TranscriptRecord } from './transcript-store';

export interface TranslateOptions {
	/** Directory where offloaded tool-results/ live for this session. */
	sessionDir?: string;
	/** Full path to the transcript .jsonl file (used to derive sessionDir if missing). */
	filePath?: string;
	/** Optional filesystem reader override for offline checks or sandboxes. */
	readFile?: (path: string) => Promise<string>;
	/** Optional callback fired when a sidecar file is actually read from disk. */
	onSidecarRead?: (filePath: string) => void;
}

export interface PersistedOutputInfo {
	filePath: string;
	preview: string;
}

/**
 * Parses <persisted-output> XML block from offloaded tool results.
 */
export function parsePersistedOutput(content: unknown): PersistedOutputInfo | null {
	const text = typeof content === 'string'
		? content
		: (Array.isArray(content)
			? content.map((c) => (typeof c === 'string' ? c : (c && typeof c === 'object' && 'text' in c ? String((c as Record<string, unknown>).text) : ''))).join('\n')
			: '');

	if (!text.includes('<persisted-output>')) {
		return null;
	}

	const pathMatch = text.match(/Full output saved to:\s*([^\r\n]+)/i);
	const filePath = pathMatch && pathMatch[1] ? pathMatch[1].trim() : '';

	// Extract preview: between Preview ...: and </persisted-output> (or end)
	let preview = '';
	const previewMatch = text.match(/Preview(?:\s*\([^)]*\))?:\s*\r?\n([\s\S]*?)(?:<\/persisted-output>|$)/i);
	if (previewMatch && previewMatch[1] !== undefined) {
		preview = previewMatch[1].trimEnd();
	} else {
		preview = text
			.replace(/<persisted-output>[\s\S]*?Preview[^:]*:\s*\r?\n?/i, '')
			.replace(/<\/persisted-output>/g, '')
			.trimEnd();
	}

	return { filePath, preview };
}

/**
 * Resolves full content of an offloaded tool result from disk, or falls back to preview.
 */
export async function resolveSidecarContent(
	info: PersistedOutputInfo,
	options?: TranslateOptions,
	toolUseId?: string,
): Promise<string> {
	let targetPath = info.filePath;
	if (targetPath.startsWith('~')) {
		const os = await nodeOs();
		const path = await nodePath();
		targetPath = path.join(os.homedir(), targetPath.slice(1));
	} else if (!targetPath && options?.sessionDir && toolUseId) {
		const path = await nodePath();
		targetPath = path.join(options.sessionDir, 'tool-results', `${toolUseId}.txt`);
	}

	if (!targetPath) {
		return info.preview;
	}

	if (options?.readFile) {
		try {
			const res = await options.readFile(targetPath);
			options.onSidecarRead?.(targetPath);
			return res;
		} catch {
			return info.preview;
		}
	}

	try {
		const fs = await nodeFs();
		const data = await fs.promises.readFile(targetPath, 'utf8');
		options?.onSidecarRead?.(targetPath);
		return data;
	} catch {
		// Sidecar missing or unreadable -> fallback to embedded preview
		return info.preview;
	}
}

function extractUserContent(record: TranscriptRecord): { text: string; images: ImageAttachment[] } {
	const msg = typeof record.message === 'object' && record.message !== null
		? (record.message as Record<string, unknown>)
		: null;
	const rawContent = msg !== null && 'content' in msg
		? msg.content
		: ('content' in record ? record.content : record.message);

	if (typeof rawContent === 'string') {
		return { text: rawContent, images: [] };
	}

	if (Array.isArray(rawContent)) {
		const textParts: string[] = [];
		const images: ImageAttachment[] = [];
		let imgIndex = 0;

		for (const block of rawContent) {
			if (!block || typeof block !== 'object') {
				continue;
			}
			const b = block as Record<string, unknown>;
			if (b.type === 'text' && typeof b.text === 'string') {
				textParts.push(b.text);
			} else if (b.type === 'image' && typeof b.source === 'object' && b.source !== null) {
				const src = b.source as Record<string, unknown>;
				if (src.type === 'base64' && typeof src.data === 'string') {
					const mediaTypeStr = typeof src.media_type === 'string' ? src.media_type : 'image/png';
					const mediaType: ImageMediaType = isImageMediaType(mediaTypeStr) ? mediaTypeStr : 'image/png';
					const data = src.data;
					const byteLength = Math.floor((data.length * 3) / 4);
					const recordUuid = typeof record.uuid === 'string' ? record.uuid : 'user-img';
					images.push({
						kind: 'image',
						id: `${recordUuid}-img-${String(imgIndex)}`,
						displayName: t('core.transcript.imageName', { index: imgIndex + 1 }),
						mediaType,
						data,
						byteLength,
					});
					imgIndex++;
				}
			}
		}

		return { text: textParts.join('\n'), images };
	}

	return { text: '', images: [] };
}

function isInterruptionRecord(record: TranscriptRecord): boolean {
	const msg = typeof record.message === 'object' && record.message !== null
		? (record.message as Record<string, unknown>)
		: null;
	const rawContent = msg !== null && 'content' in msg
		? msg.content
		: ('content' in record ? record.content : record.message);

	if (typeof rawContent === 'string') {
		return rawContent.includes('[Request interrupted by user]');
	}
	if (Array.isArray(rawContent)) {
		for (const block of rawContent) {
			if (block && typeof block === 'object') {
				const b = block as Record<string, unknown>;
				if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('[Request interrupted by user]')) {
					return true;
				}
			}
		}
	}
	return false;
}

interface IndexedToolResult {
	toolResultBlock: Record<string, unknown>;
	userRecord: TranscriptRecord;
	isDenied: boolean;
}

/**
 * Translates active-branch on-disk records into domain ChatItem[].
 */
export async function translateTranscriptRecords(
	records: TranscriptRecord[],
	options?: TranslateOptions,
): Promise<ChatItem[]> {
	if (!records || records.length === 0) {
		return [];
	}

	let sessionDir = options?.sessionDir;
	if (!sessionDir && options?.filePath) {
		sessionDir = options.filePath.replace(/\.jsonl$/, '');
	}
	const opts: TranslateOptions = { ...options, sessionDir };

	// Pass 1: Index tool results and system duration records
	const toolResultsByToolUseId = new Map<string, IndexedToolResult>();
	const turnDurationByParentUuid = new Map<string, number>();

	for (const r of records) {
		if (r.type === 'user' && r.toolUseResult !== undefined) {
			const isDenied = r.toolDenialKind !== undefined;
			const msg = typeof r.message === 'object' && r.message !== null ? (r.message as Record<string, unknown>) : null;
			const content = msg !== null && 'content' in msg ? msg.content : r.content;

			if (Array.isArray(content)) {
				for (const block of content) {
					if (block && typeof block === 'object') {
						const b = block as Record<string, unknown>;
						if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
							toolResultsByToolUseId.set(b.tool_use_id, {
								toolResultBlock: b,
								userRecord: r,
								isDenied,
							});
						}
					}
				}
			} else if (typeof r.sourceToolUseID === 'string') {
				toolResultsByToolUseId.set(r.sourceToolUseID, {
					toolResultBlock: { content },
					userRecord: r,
					isDenied,
				});
			}
		} else if (r.type === 'system' && r.subtype === 'turn_duration') {
			if (typeof r.parentUuid === 'string' && typeof r.durationMs === 'number') {
				turnDurationByParentUuid.set(r.parentUuid, r.durationMs);
			}
		}
	}

	// Pass 2: Sequential item translation
	const chatItems: ChatItem[] = [];
	let currentAssistant: AssistantItem | null = null;
	let currentAssistantUuids = new Set<string>();
	let currentSlot = 0;

	const sealAssistant = (): void => {
		if (!currentAssistant) {
			return;
		}
		// Match turn_duration strictly via parentUuid -> assistant.uuid
		for (const uuid of currentAssistantUuids) {
			if (turnDurationByParentUuid.has(uuid)) {
				currentAssistant.meta = { durationMs: turnDurationByParentUuid.get(uuid) };
				break;
			}
		}
		currentAssistant = null;
		currentAssistantUuids = new Set();
		currentSlot = 0;
	};

	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		if (!r || typeof r.type !== 'string') {
			continue;
		}

		if (r.type === 'system' && r.subtype === 'compact_boundary') {
			sealAssistant();
			const dividerId = typeof r.uuid === 'string' ? r.uuid : `divider-${String(chatItems.length)}`;
			const divider: DividerItem = {
				kind: 'divider',
				id: dividerId,
				text: t('core.conversation.compacted'),
			};
			chatItems.push(divider);
			continue;
		}

		if (r.type === 'user') {
			if (r.toolUseResult !== undefined) {
				// Tool result record; blocks matched into current assistant
				continue;
			}
			if (r.isCompactSummary === true || r.isMeta === true) {
				// System bookkeeping records
				continue;
			}
			// Machine-generated notifications (subagent progress, task completions, auto-continuations)
			// are client/system notices, not conversation turns. Per §3 ("Subagent progress and client notices:
			// omitted"), they must be omitted from conversation history.
			const originKind = r.origin && typeof r.origin === 'object' && 'kind' in r.origin
				? (r.origin as Record<string, unknown>).kind
				: undefined;
			if (originKind === 'task-notification' || originKind === 'auto-continuation') {
				// Seal the turn that preceded the notification. Without this, the assistant reply
				// that follows the notification gets merged into the already-rendered prior turn
				// instead of starting a fresh one — its text is still present in the data (appended
				// as new blocks on the old item), but a client keying its UI off item identity can
				// fail to notice the old item changed, so the reply silently never appears to show.
				sealAssistant();
				continue;
			}
			if (isInterruptionRecord(r)) {
				if (currentAssistant) {
					currentAssistant.status = 'stopped';
				}
				sealAssistant();
				continue;
			}

			// Genuine human prompt
			sealAssistant();
			const { text, images } = extractUserContent(r);
			const userId = typeof r.uuid === 'string' ? r.uuid : `user-${String(chatItems.length)}`;
			const userItem: UserItem = {
				kind: 'user',
				id: userId,
				text,
				...(images.length > 0 ? { images } : {}),
			};
			chatItems.push(userItem);
			continue;
		}

		if (r.type === 'assistant') {
			const asstUuid = typeof r.uuid === 'string' ? r.uuid : `assistant-${String(chatItems.length)}`;
			if (!currentAssistant) {
				currentAssistant = {
					kind: 'assistant',
					id: asstUuid,
					blocks: new Map(),
					status: 'complete',
				};
				chatItems.push(currentAssistant);
			}
			currentAssistantUuids.add(asstUuid);

			if (r.isApiErrorMessage === true) {
				currentAssistant.status = 'error';
				let errText = typeof r.error === 'string' ? r.error : '';
				if (!errText && typeof r.message === 'object' && r.message !== null && 'content' in (r.message as Record<string, unknown>)) {
					const rawC = (r.message as Record<string, unknown>).content;
					if (typeof rawC === 'string') {
						errText = rawC;
					} else if (Array.isArray(rawC)) {
						errText = rawC
							.map((b) => (b && typeof b === 'object' && 'text' in b && typeof (b as Record<string, unknown>).text === 'string' ? (b as Record<string, unknown>).text : ''))
							.filter(Boolean)
							.join('\n');
					}
				}
				currentAssistant.errorText = errText || t('core.transcript.apiError');
			}

			const msg = typeof r.message === 'object' && r.message !== null ? (r.message as Record<string, unknown>) : null;
			const content = msg !== null && 'content' in msg ? msg.content : r.content;

			if (typeof content === 'string') {
				const slot = currentSlot++;
				currentAssistant.blocks.set(slot, {
					index: slot,
					kind: 'text',
					text: content,
					final: true,
				});
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (!block || typeof block !== 'object') {
						continue;
					}
					const b = block as Record<string, unknown>;
					const btype = typeof b.type === 'string' ? b.type : '';

					if (btype === 'text') {
						const slot = currentSlot++;
						const blockText = typeof b.text === 'string' ? b.text : '';
						currentAssistant.blocks.set(slot, {
							index: slot,
							kind: 'text',
							text: blockText,
							final: true,
						});
					} else if (btype === 'thinking') {
						const slot = currentSlot++;
						// Stripped thinking blocks on disk carry empty string ""
						const thinkingText = typeof b.thinking === 'string' ? b.thinking : '';
						currentAssistant.blocks.set(slot, {
							index: slot,
							kind: 'thinking',
							text: thinkingText,
							final: true,
						});
					} else if (btype === 'tool_use') {
						const slot = currentSlot++;
						const toolUseId = typeof b.id === 'string' ? b.id : '';
						const toolName = typeof b.name === 'string' ? b.name : '';
						const toolInput = b.input;

						let resultTextVal = '';
						let isErrorVal = false;
						let isDeniedVal = false;

						const matchedResult = toolResultsByToolUseId.get(toolUseId);
						if (matchedResult) {
							if (matchedResult.isDenied) {
								isDeniedVal = true;
								isErrorVal = false;
							} else {
								isErrorVal = matchedResult.toolResultBlock.is_error === true;
							}

							const persisted = parsePersistedOutput(matchedResult.toolResultBlock.content);
							if (persisted) {
								resultTextVal = await resolveSidecarContent(persisted, opts, toolUseId);
							} else {
								resultTextVal = toolResultText(matchedResult.toolResultBlock.content);
							}
						}

						const mb: MessageBlock = {
							index: slot,
							kind: 'tool_use',
							text: '',
							final: true,
							toolUseId,
							toolName,
							toolInput,
							toolPending: false,
							toolResultText: resultTextVal.length > 0 ? resultTextVal : undefined,
							toolIsError: isErrorVal,
							toolDenied: isDeniedVal ? true : undefined,
							toolPermissionRequested: false,
						};
						currentAssistant.blocks.set(slot, mb);

						if (toolName === 'AskUserQuestion') {
							const askQuestions = parseAskUserQuestionInput(toolInput) ?? undefined;
							const answers = matchedResult
								? parseAskUserQuestionAnswers(matchedResult.toolResultBlock.content)
								: {};
							const permStatus: PermissionStatus = isDeniedVal
								? 'denied'
								: (matchedResult ? 'allowed' : 'cancelled');

							const permItem: PermissionItem = {
								kind: 'permission',
								id: `perm-${toolUseId}`,
								requestId: toolUseId,
								toolName: 'AskUserQuestion',
								input: toolInput,
								toolUseId,
								status: permStatus,
								askQuestions,
								answers: Object.keys(answers).length > 0 ? answers : undefined,
							};
							chatItems.push(permItem);
						}
					}
				}
			}
			continue;
		}
	}

	sealAssistant();
	return chatItems;
}

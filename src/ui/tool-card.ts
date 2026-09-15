/**
 * The surface for a `tool_use` block (PLAN Phase 4.2).
 *
 * Before this existed `MessageList.syncBlocks` skipped `tool_use` outright, so a turn that opened
 * with tool calls showed nothing new from its first text block to its last — in the captured turn
 * that is three consecutive tool calls, and Emre reads that silence as a frozen plugin. So the
 * header is drawn the moment the block opens, before any argument has finished streaming.
 *
 * The card is built once and updated in place, the same contract as the thinking block: it lives
 * inside a keyed `RenderedBlock`, and a rebuild on every delta would drop the reader's expansion
 * state and re-run the renderer over the whole transcript.
 */
import { setIcon, type Component } from 'obsidian';
import type { MessageBlock } from '../core/chat-state';
import { startsExpanded, toolCategory, toolIcon, toolSummary } from '../core/tool-policy';
import { diffFromToolInput, diffStats, renderDiff } from './diff-view';
import { t } from '../i18n';



export interface RenderedToolCard {
	el: HTMLElement;
	headerEl: HTMLButtonElement;
	iconEl: HTMLElement;
	nameEl: HTMLElement;
	summaryEl: HTMLElement;
	statusEl: HTMLElement;
	bodyEl: HTMLElement;
	expanded: boolean;
	/**
	 * Set once the reader clicks. After that the default-expansion rule stops applying: a card the
	 * reader closed must not reopen itself because a late result arrived.
	 */
	userToggled: boolean;
	/** Everything the rendered card depends on, so an unchanged card is not touched. */
	renderKey: string;
	/** Last `isError` the default-expansion rule was evaluated against. */
	appliedError: boolean;
}

export function createToolCard(parent: HTMLElement, component: Component): RenderedToolCard {
	const el = parent.createDiv({ cls: 'guki-tool-card' });

	const headerEl = el.createEl('button', { cls: 'guki-tool-header' });
	const iconEl = headerEl.createSpan({ cls: 'guki-tool-icon' });
	const nameEl = headerEl.createSpan({ cls: 'guki-tool-name' });
	const summaryEl = headerEl.createSpan({ cls: 'guki-tool-summary' });
	const statusEl = headerEl.createSpan({ cls: 'guki-tool-status' });

	const bodyEl = el.createDiv({ cls: 'guki-tool-body' });
	bodyEl.hide();

	const card: RenderedToolCard = {
		el,
		headerEl,
		iconEl,
		nameEl,
		summaryEl,
		statusEl,
		bodyEl,
		expanded: false,
		userToggled: false,
		renderKey: '',
		appliedError: false,
	};

	component.registerDomEvent(headerEl, 'click', () => {
		card.userToggled = true;
		setExpanded(card, !card.expanded);
	});

	return card;
}

function setExpanded(card: RenderedToolCard, expanded: boolean): void {
	card.expanded = expanded;
	card.el.toggleClass('guki-tool-open', expanded);
	if (expanded) {
		card.bodyEl.show();
	} else {
		card.bodyEl.hide();
	}
}

/** Returns true when it touched the DOM — the jump-to-bottom hint keys off that. */
export function updateToolCard(block: MessageBlock, card: RenderedToolCard): boolean {
	const name = block.toolName ?? t('transcript.tool.fallbackName');
	const isError = block.toolIsError === true;
	const summary = toolSummary(block.toolName, block.toolInput);
	const status = toolStatusText(block);

	// `toolInput` is part of the key: it arrives on the authoritative `assistant` event, after the
	// header has already been drawn from `content_block_start`, and the summary has to appear then.
	const key = [
		name,
		summary,
		status,
		String(isError),
		// Both drive the body, and both can arrive after the header was first drawn.
		String(block.toolDenied === true),
		String(block.toolPermissionRequested === true),
		String(block.toolResultText?.length ?? -1),
		block.toolInput === undefined ? 'no-input' : 'input',
	].join(' ');

	// The default-expansion rule is re-run when the error state changes, because that is the one
	// thing that can flip a card open after it was drawn: an error always wins (PLAN §2).
	let changed = false;
	if (!card.userToggled && (card.renderKey === '' || isError !== card.appliedError)) {
		const shouldExpand = startsExpanded(block.toolName, isError);
		if (shouldExpand !== card.expanded) {
			setExpanded(card, shouldExpand);
			changed = true;
		}
	}
	card.appliedError = isError;

	if (key === card.renderKey) {
		return changed;
	}
	card.renderKey = key;

	setIcon(card.iconEl, toolIcon(block.toolName));
	card.nameEl.setText(name);
	card.summaryEl.setText(summary);
	card.statusEl.setText(status);
	card.el.toggleClass('guki-tool-error', isError);
	// Deliberately its own class, not `guki-tool-error`: a denial is a normal outcome the
	// turn continues from (RESEARCH B5, trap 6), so it must not carry the error colour.
	card.el.toggleClass('guki-tool-denied', block.toolDenied === true);
	// A running subagent pulses too: the parent `Agent` call's own `toolPending` says nothing
	// about whether the work underneath it is still moving.
	card.el.toggleClass(
		'guki-tool-running',
		block.toolPending === true || block.subagentActive === true,
	);
	card.el.toggleClass(`guki-tool-${toolCategory(block.toolName)}`, true);

	renderBody(block, card);
	return true;
}

/**
 * The right-hand end of the header line.
 *
 * The subagent line takes precedence over "Running…" — when an `Agent` call is in flight, what the
 * reader wants to know is that something is happening *underneath* it. This is the whole of PLAN
 * Phase 4.5's surface: one line, content hidden, resolved when the parent call returns.
 *
 * It says what the subagent is actually doing, because `system/task_progress` carries a live
 * `description` and a rising `tool_uses` count (PHASE4-STATE F7). A fixed "subagent running…" for
 * the minute a subagent can take is barely better than the silence the rule exists to prevent.
 * When those events are absent the fixed string is still the fallback.
 *
 * Exported for `docs/offline-checks.ts` §L: it is where "a denial is not a failure" turns into
 * something the reader sees, and a check that restated the condition instead of calling this
 * would pass against a card that had been changed back.
 */
export function toolStatusText(block: MessageBlock): string {
	if (block.subagentActive === true) {
		const label = block.subagentLabel ?? t('transcript.tool.subagentRunning');
		const uses = block.subagentToolUses;
		return uses === undefined
			? t('transcript.tool.subagentStatus', { label })
			: t('transcript.tool.subagentStatusWithUses', { label, count: uses });
	}
	if (block.toolPending === true) {
		// While an approval card is open the call is not "running" — it is waiting on the
		// reader, and saying so points them at the control they have to use.
		return block.toolPermissionRequested === true && block.toolDenied !== true
			? t('transcript.tool.waitingForApproval')
			: t('transcript.tool.running');
	}
	// Checked before `toolIsError`, though the reducer already keeps the two mutually
	// exclusive: if that ever drifts, the outcome the reader chose should still win over the
	// CLI's flag.
	if (block.toolDenied === true) {
		return t('transcript.tool.denied');
	}
	if (block.toolIsError === true) {
		return t('transcript.tool.error');
	}
	return '';
}

function renderBody(block: MessageBlock, card: RenderedToolCard): void {
	const body = card.bodyEl;
	body.empty();



	// A diff for the edit tools, the raw arguments for everything else. `diffFromToolInput`
	// returns null when the input does not have the shape it expects, so a tool that grows a new
	// argument spelling degrades to the argument view instead of rendering an empty diff.
	// A call that went through the permission bridge has an approval card of its own, and that
	// card already shows this diff — in full, with the target path spelled out, next to the
	// buttons the reader has to press. Drawing it again here produced two identical
	// Before/After panes stacked on each other, one passive and one actionable (Emre's Phase
	// 5a acceptance run, finding 2). The header still carries the tool name, the path and the
	// live status, and the result is still shown below once it lands.
	const diff =
		block.toolPermissionRequested === true ? null : diffFromToolInput(block.toolName, block.toolInput);
	if (diff) {
		// The path is **not** repeated here. It is already the header's one-line summary
		// (`toolSummary`), which is the line PLAN §2 specifies and the only line a collapsed card
		// shows — so the body copy was redundant in the wide layout, and in the narrow one it cost
		// a second full-width row directly under the row that already said the same thing.
		const stats = diffStats(diff);
		body.createDiv({
			cls: 'guki-tool-diffstat',
			text: t('transcript.tool.diffStats', { added: stats.added, removed: stats.removed }),
		});
		renderDiff(body.createDiv(), diff);
	} else if (block.toolPermissionRequested === true) {
		// The arguments are not repeated either, for the same reason. `Write` is an `expanded`
		// category tool, so this card opens by itself — with nothing here it would open onto
		// "No output." and read as though something had gone wrong.
		body.createDiv({
			cls: 'guki-tool-empty',
			text: toolPermissionBodyText(block),
		});
	} else if (block.toolInput !== undefined) {
		const args = formatInput(block.toolInput);
		if (args.length > 0) {
			body.createEl('pre', { cls: 'guki-tool-args' }).createEl('code', { text: args });
		}
	}

	const result = block.toolResultText;
	if (result !== undefined && result.length > 0) {
		body.createDiv({
			cls: 'guki-tool-result-title',
			text: toolResultTitle(block),
		});
		// `setText` through the element options, never the markdown renderer: tool output is not
		// prose, and a result containing a fence would otherwise restyle the card.
		body.createEl('pre', { cls: 'guki-tool-result' }).createEl('code', { text: result });
	}

	if (body.childElementCount === 0) {
		body.createDiv({ cls: 'guki-tool-empty', text: t('transcript.tool.noOutput') });
	}
}

/**
 * What a bridged tool call displays in its body while waiting or once resolved.
 * Permission cards mount in the composer slot, never inline below the tool card.
 */
export function toolPermissionBodyText(block: MessageBlock): string {
	if (block.toolPending === true) {
		return block.toolName === 'AskUserQuestion'
			? t('transcript.tool.waitingForResponse')
			: t('transcript.tool.waitingForComposerApproval');
	}
	if (block.toolDenied === true) {
		return t('transcript.tool.deniedInComposer');
	}
	return block.toolName === 'AskUserQuestion'
		? t('transcript.tool.answeredInComposer')
		: t('transcript.tool.handledInComposer');
}

/**
 * What the result block is called. "Error" is reserved for a real tool failure — the CLI's
 * message for a denial is an explanation, not a stack trace, and heading it "Error" is the same
 * mislabelling the badge was.
 */
export function toolResultTitle(block: MessageBlock): string {
	if (block.toolDenied === true) {
		return t('transcript.tool.denied');
	}
	return block.toolIsError === true ? t('transcript.tool.error') : t('transcript.tool.result');
}

/** Bash shows its command bare; everything else shows its arguments as JSON. */
function formatInput(input: unknown): string {
	if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
		const command = (input as Record<string, unknown>).command;
		if (typeof command === 'string') {
			return command;
		}
	}
	try {
		return JSON.stringify(input, null, 2) ?? '';
	} catch {
		// A cyclic or otherwise unserialisable input must not take the card down with it.
		return '';
	}
}

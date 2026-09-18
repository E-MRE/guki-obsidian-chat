/**
 * The approval surface (PLAN Phase 5.4): tool name, arguments, a diff preview for the edit tools,
 * Allow and Deny.
 *
 * Nothing here re-derives what the tool card already knows. `toolIcon` and `toolSummary` come from
 * `core/tool-policy.ts` so a tool reads the same on both surfaces, and `diffFromToolInput` /
 * `renderDiff` come from `diff-view.ts`. This is the card `DiffInput.path` was kept for: the tool
 * card drops it because its header already prints the path, but here the reader is being asked to
 * approve a write, and the target has to be stated in the body rather than ellipsised in a header.
 *
 * Built once and updated in place, the same contract as `tool-card.ts`. A card rebuilt on every
 * state change would take the buttons out from under the pointer.
 *
 * **Denied is not an error state.** A denied tool leaves `result.subtype === 'success'` and
 * `is_error === false`, and the turn carries on (RESEARCH B5, trap 6) — so the resolved card gets
 * no error colour and no failure badge.
 */
import { setIcon, type Component } from 'obsidian';
import type { PermissionItem, PermissionStatus } from '../core/chat-state';
import type { PermissionBehavior } from '../core/permission-broker';
import { isFloorProtectedRequest, type VaultPaths } from '../core/permission-policy';
import { validateBashFloor } from '../core/bash-whitelist';
import { toolIcon, toolSummary } from '../core/tool-policy';
import { diffFromToolInput, renderDiff, type DiffInput } from './diff-view';
import { t } from '../i18n';

export interface PermissionActions {
	decide(requestId: string, behavior: PermissionBehavior, remember?: boolean): void;
}

export interface RenderedPermissionCard {
	el: HTMLElement;
	iconEl: HTMLElement;
	titleEl: HTMLElement;
	summaryEl: HTMLElement;
	bodyEl: HTMLElement;
	actionsEl: HTMLElement;
	allowEl: HTMLButtonElement;
	denyEl: HTMLButtonElement;
	rememberEl?: HTMLElement;
	rememberCheckbox?: HTMLInputElement;
	statusEl: HTMLElement;
	/** Everything the rendered card depends on, so an unchanged card is not touched. */
	renderKey: string;
	/** Whether the body has been filled. The arguments never change after the request arrives. */
	bodyRendered: boolean;
}

/**
 * Gating predicate: only ordinary tool permission requests offer "don't ask again".
 * AskUserQuestion must NEVER offer it because questions cannot be meaningfully pre-answered.
 *
 * For Bash this must mirror `buildRememberedDecision`'s metacharacter veto (bash-whitelist.ts):
 * a command with a pipe, `&&`, etc. can never be turned into a remembered rule, so the checkbox
 * used to show anyway, the user would check it and hit Allow, and the decision would silently
 * fail to persist — no error, no explanation, just "always allow" that never sticks.
 */
export function canRememberPermission(item: PermissionItem, paths?: VaultPaths): boolean {
	if (item.toolName === 'AskUserQuestion') {
		return false;
	}
	if (isFloorProtectedRequest(item.toolName, item.input, paths)) {
		return false;
	}
	if (item.toolName === 'Bash') {
		const command = (item.input as Record<string, unknown> | null)?.command;
		if (validateBashFloor(command, item.cwd, paths) === null) {
			return false;
		}
	}
	return true;
}

/**
 * Shortens a directory path for display on the permission card label,
 * keeping the meaningful end visible (shortened at the front if longer than maxLen).
 */
export function shortenPathForLabel(path: string, maxLen = 35): string {
	const norm = path.normalize('NFC');
	if (norm.length <= maxLen) {
		return norm;
	}
	const slice = norm.slice(norm.length - (maxLen - 1));
	const slashIdx = slice.indexOf('/');
	if (slashIdx !== -1 && slashIdx < 10) {
		return `…${slice.slice(slashIdx)}`;
	}
	return `…${slice}`;
}

/**
 * Exact wording for the "don't ask again" affordance.
 * For Bash: explicitly names the directory (shortened if long) so the user sees what they agree to.
 * For files: explicitly scoped to this exact path.
 * The sentence and what is stored stay in agreement.
 */
export function rememberLabelText(toolName: string, directory?: string): string {
	if (toolName === 'Bash') {
		if (typeof directory === 'string' && directory.trim().length > 0) {
			return t('transcript.permission.rememberCommandInDirectory', {
				directory: shortenPathForLabel(directory.trim()),
			});
		}
		return t('transcript.permission.rememberCommandHere');
	}
	return t('transcript.permission.rememberPath');
}

export function createPermissionCard(
	parent: HTMLElement,
	component: Component,
	item: PermissionItem,
	actions: PermissionActions,
	paths?: VaultPaths,
): RenderedPermissionCard {
	const el = parent.createDiv({ cls: 'guki-perm-card' });

	const headerEl = el.createDiv({ cls: 'guki-perm-header' });
	const iconEl = headerEl.createSpan({ cls: 'guki-perm-icon' });
	const titleEl = headerEl.createSpan({ cls: 'guki-perm-title' });
	const summaryEl = headerEl.createSpan({ cls: 'guki-perm-summary' });

	const bodyEl = el.createDiv({ cls: 'guki-perm-body' });

	const actionsEl = el.createDiv({ cls: 'guki-perm-actions' });
	// Deny first in the DOM but ordered second by CSS, so a keyboard tab lands on the safer choice
	// first while the eye still reads Allow on the left.
	const denyEl = actionsEl.createEl('button', { cls: 'guki-perm-deny', text: t('transcript.permission.deny') });

	let rememberEl: HTMLElement | undefined;
	let rememberCheckbox: HTMLInputElement | undefined;
	if (canRememberPermission(item, paths)) {
		rememberEl = actionsEl.createDiv({ cls: 'guki-perm-remember' });
		const checkboxId = `guki-perm-rem-${item.requestId}`;
		rememberCheckbox = rememberEl.createEl('input', {
			cls: 'guki-perm-remember-checkbox',
			attr: { type: 'checkbox', id: checkboxId },
		});
		const directory =
			item.cwd ??
			(typeof item.input === 'object' && item.input !== null
				? ((item.input as Record<string, unknown>).cwd as string | undefined)
				: undefined);
		rememberEl.createEl('label', {
			cls: 'guki-perm-remember-label',
			text: rememberLabelText(item.toolName, directory),
			attr: { for: checkboxId },
		});
	}

	const allowEl = actionsEl.createEl('button', { cls: 'guki-perm-allow', text: t('transcript.permission.allow') });

	const statusEl = el.createDiv({ cls: 'guki-perm-status' });

	const card: RenderedPermissionCard = {
		el,
		iconEl,
		titleEl,
		summaryEl,
		bodyEl,
		actionsEl,
		allowEl,
		denyEl,
		rememberEl,
		rememberCheckbox,
		statusEl,
		renderKey: '',
		bodyRendered: false,
	};

	// The buttons are disabled the moment either is pressed, so a double click cannot send a second
	// decision — the broker drops it anyway, but a card that still looks actionable after being
	// answered is its own bug.
	component.registerDomEvent(allowEl, 'click', () => {
		if (allowEl.disabled) {
			return;
		}
		const remember = rememberCheckbox?.checked ?? false;
		setActionsEnabled(card, false);
		actions.decide(item.requestId, 'allow', remember);
	});
	component.registerDomEvent(denyEl, 'click', () => {
		if (denyEl.disabled) {
			return;
		}
		setActionsEnabled(card, false);
		actions.decide(item.requestId, 'deny');
	});
	if (rememberCheckbox) {
		component.registerDomEvent(rememberCheckbox, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				if (allowEl.disabled) {
					return;
				}
				rememberCheckbox.checked = true;
				setActionsEnabled(card, false);
				actions.decide(item.requestId, 'allow', true);
			}
		});
	}
	component.registerDomEvent(el, 'keydown', (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			if (denyEl.disabled) {
				return;
			}
			setActionsEnabled(card, false);
			actions.decide(item.requestId, 'deny');
		}
	});

	return card;
}

function setActionsEnabled(card: RenderedPermissionCard, enabled: boolean): void {
	card.allowEl.disabled = !enabled;
	card.denyEl.disabled = !enabled;
	if (card.rememberCheckbox) {
		card.rememberCheckbox.disabled = !enabled;
	}
}

/** Returns true when it touched the DOM — the jump-to-bottom hint keys off that. */
export function updatePermissionCard(item: PermissionItem, card: RenderedPermissionCard): boolean {
	const key = `${item.toolName}:${item.status}:${String(item.requestId)}`;
	if (key === card.renderKey) {
		return false;
	}
	card.renderKey = key;

	setIcon(card.iconEl, toolIcon(item.toolName));
	card.titleEl.setText(item.toolName);
	card.summaryEl.setText(toolSummary(item.toolName, item.input));

	if (!card.bodyRendered) {
		renderBody(item, card.bodyEl);
		card.bodyRendered = true;
	}

	// One class carries the state, so the stylesheet decides what each looks like and no colour is
	// chosen here. `guki-perm-denied` deliberately does not reuse the error colour.
	for (const status of ['pending', 'allowed', 'denied', 'cancelled'] satisfies PermissionStatus[]) {
		card.el.toggleClass(`guki-perm-${status}`, item.status === status);
	}

	const pending = item.status === 'pending';
	setActionsEnabled(card, pending);
	if (pending) {
		card.actionsEl.show();
	} else {
		card.actionsEl.hide();
	}
	card.statusEl.setText(statusText(item.status));
	return true;
}

/**
 * `cancelled` is worded as something that happened *to* the request rather than as a decision: the
 * reader did not deny anything, the turn ended underneath them and the broker answered on their
 * behalf so the CLI would not hang (PHASE5A-STATE D5).
 */
export function statusText(status: PermissionStatus): string {
	switch (status) {
		case 'pending':
			return '';
		case 'allowed':
			return t('transcript.permission.allowed');
		case 'denied':
			return t('transcript.permission.deniedContinues');
		case 'cancelled':
			return t('transcript.permission.cancelled');
	}
}

/**
 * The card's diff, including the prior content that makes a `Write`'s Before pane honest.
 *
 * Exported, and a function rather than a line inside `renderBody`, for one reason: `renderBody`
 * needs a DOM and the offline checks have none, so the one line that carries `priorContent` from
 * the item to the parser would otherwise be untested. Deleting the third argument breaks nothing a
 * check can see — and "the wiring is untested if a reversion of it is green" is how three earlier
 * reversions in this project passed while a real call site was already gone.
 */
export function permissionDiff(item: PermissionItem): DiffInput | null {
	// Absent `priorContent` means unknown, which is what `diffFromToolInput` defaults to.
	return diffFromToolInput(item.toolName, item.input, item.priorContent);
}

function renderBody(item: PermissionItem, body: HTMLElement): void {
	body.empty();

	const diff = permissionDiff(item);
	if (diff) {
		// The path **is** rendered here, unlike on the tool card. Approving a write without being
		// told which file is being written to is not a decision the reader can make; the header
		// summary ellipsises it, and this is the surface where that is not good enough.
		if (diff.path !== undefined) {
			const target = body.createDiv({ cls: 'guki-perm-target' });
			target.createSpan({ cls: 'guki-perm-target-label', text: t('transcript.permission.file') });
			target.createSpan({ cls: 'guki-perm-target-path', text: diff.path });
		}
		renderDiff(body.createDiv(), diff);
		return;
	}

	const args = formatInput(item.input);
	if (args.length > 0) {
		body.createEl('pre', { cls: 'guki-perm-args' }).createEl('code', { text: args });
		return;
	}
	body.createDiv({ cls: 'guki-perm-empty', text: t('transcript.permission.noArguments') });
}

/** Bash shows its command bare; everything else shows its arguments as JSON. Mirrors `tool-card`. */
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

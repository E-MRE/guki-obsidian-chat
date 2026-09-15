import type { PermissionBehavior } from './permission-broker';
import { t } from '../i18n';

export interface AskQuestionOption {
	label: string;
	description?: string;
	value: string;
}

export interface AskQuestionDef {
	question: string;
	id?: string;
	header?: string;
	options?: AskQuestionOption[];
	multiSelect?: boolean;
	isOther?: boolean;
}

export function parseAskUserQuestionInput(input: unknown): AskQuestionDef[] | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;
	if (!Array.isArray(obj.questions)) {
		return null;
	}
	
	const result: AskQuestionDef[] = [];
	for (const q of obj.questions) {
		if (!q || typeof q !== 'object') {
			return null;
		}
		
		const qObj = q as Record<string, unknown>;
		if (typeof qObj.question !== 'string') {
			return null;
		}
		
		const def: AskQuestionDef = {
			question: qObj.question
		};
		
		if (typeof qObj.id === 'string') {
			def.id = qObj.id;
		}
		if (typeof qObj.header === 'string') {
			def.header = qObj.header;
		}
		if (typeof qObj.multiSelect === 'boolean') {
			def.multiSelect = qObj.multiSelect;
		}
		if (typeof qObj.isOther === 'boolean') {
			def.isOther = qObj.isOther;
		}
		
		if (Array.isArray(qObj.options)) {
			const options: AskQuestionOption[] = [];
			for (const opt of qObj.options) {
				if (opt && typeof opt === 'object') {
					const o = opt as Record<string, unknown>;
					if (typeof o.label === 'string') {
						const optObj: AskQuestionOption = {
							label: o.label,
							value: typeof o.value === 'string' ? o.value : o.label
						};
						if (typeof o.description === 'string') {
							optObj.description = o.description;
						}
						options.push(optObj);
					}
				}
			}
			if (options.length > 0) {
				def.options = options;
			}
		}
		
		result.push(def);
	}
	
	return result.length > 0 ? result : null;
}

export interface AskUserQuestionDecision {
	behavior: PermissionBehavior;
	updatedInput?: Record<string, unknown>;
}

/**
 * Resolves the permission verdict and payload for AskUserQuestion.
 * Fail-closed: unreadable socket input or reader cancellation (answers === null)
 * must produce 'deny', never a silent or unconditional 'allow'.
 */
export function decideAskUserQuestion(
	input: unknown,
	answers: Record<string, string | string[]> | null,
): AskUserQuestionDecision {
	if (answers === null) {
		return { behavior: 'deny' };
	}
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		return { behavior: 'deny' };
	}
	return {
		behavior: 'allow',
		updatedInput: { ...(input as Record<string, unknown>), answers },
	};
}

/**
 * Renders the authoritative one-line summary for AskUserQuestion cards.
 * Reused across both live permission summaries and historical transcript reconstruction.
 */
export function formatAskUserQuestionSummary(
	askQuestions?: AskQuestionDef[],
	answers?: Record<string, string | string[]>,
	status: 'pending' | 'allowed' | 'denied' | 'cancelled' = 'allowed',
): string {
	if (askQuestions && askQuestions.length > 0) {
		if (status === 'allowed') {
			const parts = askQuestions.map((q, idx) => {
				const ans = answers
					? answers[String(idx)] ?? (q.id ? answers[q.id] : undefined) ?? answers[q.question]
					: undefined;
				const ansStr = Array.isArray(ans) ? ans.join(', ') : typeof ans === 'string' ? ans : '';
				return t('core.ask.questionAnswer', { question: q.question, answer: ansStr });
			});
			return t('core.ask.questionsAnswered', { questions: parts.join(' · ') });
		} else if (status === 'denied') {
			return t('core.ask.questionsDenied', { questions: askQuestions.map((q) => q.question).join(' · ') });
		} else {
			return t('core.ask.questionsNotAnswered', { questions: askQuestions.map((q) => q.question).join(' · ') });
		}
	} else {
		if (status === 'allowed') {
			return t('core.ask.answered');
		} else if (status === 'denied') {
			return t('core.ask.unreadableDenied');
		} else {
			return t('core.ask.unreadableNotAnswered');
		}
	}
}

/**
 * Extracts answered question/answer pairs from on-disk tool_result content.
 */
export function parseAskUserQuestionAnswers(content: unknown): Record<string, string> {
	const text = typeof content === 'string'
		? content
		: (Array.isArray(content)
			? content.map(c => typeof c === 'string' ? c : (c && typeof c === 'object' && 'text' in c ? String((c as Record<string, unknown>).text) : '')).join(' ')
			: '');
	const answers: Record<string, string> = {};
	if (!text) return answers;

	const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"="([^"\\]*(?:\\.[^"\\]*)*)"/g;
	let match: RegExpExecArray | null;
	let idx = 0;
	while ((match = regex.exec(text)) !== null) {
		const q = match[1];
		const a = match[2];
		if (q !== undefined && a !== undefined) {
			const qText = q.replace(/\\"/g, '"');
			const aText = a.replace(/\\"/g, '"');
			answers[qText] = aText;
			answers[String(idx)] = aText;
			idx++;
		}
	}
	return answers;
}

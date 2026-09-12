import { Component } from 'obsidian';
import type { PermissionItem } from '../core/chat-state';
import { type AskQuestionDef, parseAskUserQuestionInput } from '../core/ask-user-question';



export class AskUserQuestionInline {
	readonly el: HTMLElement;
	private currentTabIndex = 0;
	
	// State for answers
	private selections: Record<string, string[]> = {};
	private customTexts: Record<string, string> = {};
	
	private tabBarEl: HTMLElement;
	private contentEl: HTMLElement;
	private questions: AskQuestionDef[] = [];
	
	// Keyboard navigation state
	private focusedItemIndex = 0;
	private isMalformed = false;
	
	constructor(
		private readonly container: HTMLElement,
		private readonly component: Component,
		private readonly item: PermissionItem,
		private readonly onDecide: (answers: Record<string, string | string[]> | null) => void
	) {
		const parsed = item.askQuestions ?? parseAskUserQuestionInput(item.input);
		if (parsed) {
			this.questions = parsed;
			this.item.askQuestions = parsed;
		} else {
			this.isMalformed = true;
		}
		
		this.el = this.container.createDiv({ cls: 'guki-ask-question-inline' });
		this.el.tabIndex = 0;
		
		this.tabBarEl = this.el.createDiv({ cls: 'guki-ask-tab-bar' });
		this.contentEl = this.el.createDiv({ cls: 'guki-ask-content' });
		
		this.renderTabBar();
		this.renderTabContent();
		
		this.component.registerDomEvent(this.el, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
		this.component.registerDomEvent(this.el, 'click', (e: MouseEvent) => {
			if ((e.target as HTMLElement)?.tagName !== 'INPUT') {
				this.el.focus();
			}
		});
		
		if (typeof window !== 'undefined' && window.requestAnimationFrame) {
			window.requestAnimationFrame(() => {
				this.el.focus();
			});
		} else {
			this.el.focus();
		}
	}
	
	private renderTabBar() {
		this.tabBarEl.empty();
		if (this.isMalformed || this.questions.length <= 1) {
			if (typeof this.tabBarEl.hide === 'function') {
				this.tabBarEl.hide();
			} else {
				this.tabBarEl.addClass('guki-hidden');
			}
			return;
		}
		if (typeof this.tabBarEl.show === 'function') {
			this.tabBarEl.show();
		} else {
			this.tabBarEl.removeClass('guki-hidden');
		}
		
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			if (!q) continue;
			const isAnswered = this.isQuestionAnswered(q, i);
			
			const tab = this.tabBarEl.createDiv({ cls: 'guki-ask-tab' });
			if (i === this.currentTabIndex) {
				tab.addClass('guki-ask-active');
			}
			if (isAnswered) {
				tab.addClass('guki-ask-answered');
			}
			tab.setText(q.header || `Q${i + 1}`);
			
			tab.addEventListener('click', () => {
				this.currentTabIndex = i;
				this.focusedItemIndex = 0;
				this.renderTabBar();
				this.renderTabContent();
			});
		}
		
		const submitBtn = this.tabBarEl.createEl('button', {
			cls: 'guki-ask-tab-submit',
			text: 'Submit'
		});
		const allAnswered = this.questions.every((q, idx) => this.isQuestionAnswered(q, idx));
		if (allAnswered) {
			submitBtn.addClass('guki-ask-answered');
		}
		
		submitBtn.addEventListener('click', () => {
			if (allAnswered) {
				this.submit();
			} else {
				const firstUnanswered = this.questions.findIndex((q, idx) => !this.isQuestionAnswered(q, idx));
				if (firstUnanswered !== -1) {
					this.currentTabIndex = firstUnanswered;
					this.focusedItemIndex = 0;
					this.renderTabBar();
					this.renderTabContent();
				}
			}
		});
	}
	
	private getQuestionId(_q: AskQuestionDef, index: number): string {
		return String(index);
	}
	
	private isQuestionAnswered(q: AskQuestionDef, index: number): boolean {
		const qId = this.getQuestionId(q, index);
		const sels = this.selections[qId] || [];
		const custom = this.customTexts[qId];
		return sels.length > 0 || (custom !== undefined && custom.trim().length > 0);
	}
	
	private renderTabContent() {
		this.contentEl.empty();
		
		if (this.isMalformed) {
			this.contentEl.createDiv({ cls: 'guki-ask-question', text: 'This question from the assistant could not be read.' });
			const denyBtn = this.contentEl.createEl('button', { text: 'Deny' });
			denyBtn.addEventListener('click', () => this.onDecide(null));
			return;
		}
		
		const q = this.questions[this.currentTabIndex];
		if (!q) return;
		const qId = this.getQuestionId(q, this.currentTabIndex);
		
		this.contentEl.createDiv({ cls: 'guki-ask-question', text: q.question });
		
		const sels = this.selections[qId] || [];
		
		const optionsList = this.contentEl.createDiv({ cls: 'guki-ask-options' });
		
		let optionIndex = 0;
		if (q.options) {
			for (const opt of q.options) {
				const itemEl = optionsList.createDiv({ cls: 'guki-ask-item' });
				const isSelected = sels.includes(opt.value);
				
				if (isSelected) {
					itemEl.addClass('guki-ask-selected');
				}
				if (this.focusedItemIndex === optionIndex) {
					itemEl.addClass('guki-ask-focused');
					if (typeof itemEl.scrollIntoView === 'function') {
						itemEl.scrollIntoView({ block: 'nearest' });
					}
				}
				
				itemEl.createSpan({ text: opt.label });
				if (opt.description) {
					itemEl.createSpan({ cls: 'guki-ask-description', text: ` - ${opt.description}` });
				}
				
				const currentIndex = optionIndex;
				itemEl.addEventListener('click', () => {
					this.focusedItemIndex = currentIndex;
					this.toggleOption(q, this.currentTabIndex, opt.value);
				});
				
				optionIndex++;
			}
		}
		
		// Free-text ("Other") row is always rendered for every question
		const otherIndex = optionIndex;
		const otherEl = optionsList.createDiv({ cls: 'guki-ask-custom-text' });
		if (this.focusedItemIndex === otherIndex) {
			otherEl.addClass('guki-ask-focused');
			if (typeof otherEl.scrollIntoView === 'function') {
				otherEl.scrollIntoView({ block: 'nearest' });
			}
		}
		
		const currentText = this.customTexts[qId] || '';
		if (currentText.trim().length > 0) {
			otherEl.addClass('guki-ask-selected');
		}
		
		const inputEl = otherEl.createEl('input', {
			attr: {
				type: 'text',
				placeholder: 'Other…'
			}
		});
		inputEl.value = currentText;

		let actionBtn: HTMLButtonElement | undefined;

		const clearOptionSelections = () => {
			if (!q.multiSelect) {
				this.selections[qId] = [];
				optionsList.querySelectorAll('.guki-ask-item.guki-ask-selected').forEach(el => {
					el.removeClass('guki-ask-selected');
				});
				this.renderTabBar();
				if (actionBtn) {
					actionBtn.disabled = !this.isQuestionAnswered(q, this.currentTabIndex);
				}
			}
		};
		
		otherEl.addEventListener('click', (e) => {
			this.focusedItemIndex = otherIndex;
			clearOptionSelections();
			if ((e.target as HTMLElement) !== inputEl) {
				inputEl.focus();
			}
		});
		
		inputEl.addEventListener('focus', () => {
			this.focusedItemIndex = otherIndex;
			clearOptionSelections();
			otherEl.addClass('guki-ask-focused');
		});
		
		inputEl.addEventListener('blur', () => {
			otherEl.removeClass('guki-ask-focused');
		});
		
		inputEl.addEventListener('input', (e) => {
			const val = (e.target as HTMLInputElement).value;
			this.customTexts[qId] = val;
			
			if (!q.multiSelect) {
				this.selections[qId] = [];
				optionsList.querySelectorAll('.guki-ask-item.guki-ask-selected').forEach(el => {
					el.removeClass('guki-ask-selected');
				});
			}
			
			this.renderTabBar();
			if (val.trim().length > 0) {
				otherEl.addClass('guki-ask-selected');
			} else {
				otherEl.removeClass('guki-ask-selected');
			}
			if (actionBtn) {
				actionBtn.disabled = !this.isQuestionAnswered(q, this.currentTabIndex);
			}
		});

		const actionsEl = this.contentEl.createDiv({ cls: 'guki-ask-actions' });
		const isLastQuestion = this.currentTabIndex === this.questions.length - 1;
		const isAnswered = this.isQuestionAnswered(q, this.currentTabIndex);
		actionBtn = actionsEl.createEl('button', {
			cls: 'guki-ask-submit-btn',
			text: isLastQuestion ? 'Submit' : 'Next'
		});
		actionBtn.disabled = !isAnswered;
		actionBtn.addEventListener('click', () => {
			if (!this.isQuestionAnswered(q, this.currentTabIndex)) return;
			if (isLastQuestion) {
				this.submit();
			} else {
				this.currentTabIndex++;
				this.focusedItemIndex = 0;
				this.renderTabBar();
				this.renderTabContent();
			}
		});
	}
	
	private toggleOption(q: AskQuestionDef, index: number, value: string) {
		const qId = this.getQuestionId(q, index);
		let sels = this.selections[qId] || [];
		
		if (q.multiSelect) {
			if (sels.includes(value)) {
				sels = sels.filter(v => v !== value);
			} else {
				sels.push(value);
			}
			this.selections[qId] = sels;
		} else {
			this.selections[qId] = [value];
			this.customTexts[qId] = '';
			
			// Single select: advances if more questions
			if (this.currentTabIndex < this.questions.length - 1) {
				this.currentTabIndex++;
				this.focusedItemIndex = 0;
			}
		}
		
		this.renderTabBar();
		this.renderTabContent();

		if (!q.multiSelect && index === this.questions.length - 1) {
			this.submit();
		}
	}
	
	private onKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			this.onDecide(null); // Deny
			return;
		}
		
		if (this.isMalformed) {
			return;
		}

		const isInput = (e.target as HTMLElement)?.tagName === 'INPUT';
		if (isInput) {
			if (e.key === 'Enter') {
				e.preventDefault();
				const q = this.questions[this.currentTabIndex];
				if (!q) return;
				const qId = this.getQuestionId(q, this.currentTabIndex);
				const custom = (this.customTexts[qId] || '').trim();
				// Fail-closed: empty custom answer is not submittable
				if (custom.length === 0) {
					return;
				}
				if (!this.isQuestionAnswered(q, this.currentTabIndex)) {
					return;
				}
				(e.target as HTMLElement).blur();
				this.el.focus();
				if (this.currentTabIndex === this.questions.length - 1) {
					this.submit();
				} else {
					this.currentTabIndex++;
					this.focusedItemIndex = 0;
					this.renderTabBar();
					this.renderTabContent();
				}
				return;
			}
			if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				(e.target as HTMLElement).blur();
				this.el.focus();
				const q = this.questions[this.currentTabIndex];
				const optCount = q?.options ? q.options.length : 0;
				if (e.key === 'ArrowUp') {
					this.focusedItemIndex = Math.max(0, optCount - 1);
					this.renderTabContent();
				}
				return;
			} else {
				return;
			}
		}

		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			if (this.questions.length > 1) {
				e.preventDefault();
				if (e.key === 'ArrowLeft') {
					this.currentTabIndex = Math.max(0, this.currentTabIndex - 1);
				} else {
					this.currentTabIndex = Math.min(this.questions.length - 1, this.currentTabIndex + 1);
				}
				this.focusedItemIndex = 0;
				this.renderTabBar();
				this.renderTabContent();
			}
			return;
		}

		const q = this.questions[this.currentTabIndex];
		if (!q) return;
		const optCount = q.options ? q.options.length : 0;
		const numOptions = optCount + 1; // options + Other

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (numOptions > 0) {
				this.focusedItemIndex = Math.min(numOptions - 1, this.focusedItemIndex + 1);
				this.renderTabContent();
			}
			return;
		}

		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (numOptions > 0) {
				this.focusedItemIndex = Math.max(0, this.focusedItemIndex - 1);
				this.renderTabContent();
			}
			return;
		}

		if (e.key === 'Enter') {
			e.preventDefault();
			const isLastQuestion = this.currentTabIndex === this.questions.length - 1;
			if (this.focusedItemIndex >= 0 && this.focusedItemIndex < optCount) {
				const opt = q.options![this.focusedItemIndex]!;
				this.toggleOption(q, this.currentTabIndex, opt.value);
				return;
			}
			if (this.focusedItemIndex === optCount) {
				const qId = this.getQuestionId(q, this.currentTabIndex);
				if (!q.multiSelect) {
					this.selections[qId] = [];
					this.renderTabBar();
				}
				const inputEl = this.contentEl.querySelector('input');
				inputEl?.focus();
				return;
			}
			if (isLastQuestion && this.isQuestionAnswered(q, this.currentTabIndex)) {
				this.submit();
			}
		}
	}
	
	private submit() {
		const allAnswered = this.questions.every((q, idx) => this.isQuestionAnswered(q, idx));
		if (!allAnswered) return;
		
		const finalAnswers: Record<string, string | string[]> = {};
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			if (!q) continue;
			const qId = this.getQuestionId(q, i);
			const sels = this.selections[qId] || [];
			const custom = (this.customTexts[qId] || '').trim();
			
			let answer: string | string[];
			if (q.multiSelect) {
				const ans = [...sels];
				if (custom.length > 0) ans.push(custom);
				answer = ans;
			} else {
				if (custom.length > 0) {
					answer = custom;
				} else if (sels.length > 0) {
					answer = sels[0]!;
				} else {
					return; // Fail-closed
				}
			}
			finalAnswers[qId] = answer;
			if (q.id && !finalAnswers[q.id]) {
				finalAnswers[q.id] = answer;
			}
		}
		
		this.item.answers = finalAnswers;
		this.onDecide(finalAnswers);
	}
	
	destroy(): void {
		this.el.remove();
	}
}

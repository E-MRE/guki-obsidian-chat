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
		const parsed = parseAskUserQuestionInput(item.input);
		if (parsed) {
			this.questions = parsed;
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
			const isAnswered = this.isQuestionAnswered(q);
			
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
		const allAnswered = this.questions.every(q => this.isQuestionAnswered(q));
		if (allAnswered) {
			submitBtn.addClass('guki-ask-answered');
		}
		
		submitBtn.addEventListener('click', () => {
			if (allAnswered) {
				this.submit();
			} else {
				const firstUnanswered = this.questions.findIndex(q => !this.isQuestionAnswered(q));
				if (firstUnanswered !== -1) {
					this.currentTabIndex = firstUnanswered;
					this.focusedItemIndex = 0;
					this.renderTabBar();
					this.renderTabContent();
				}
			}
		});
	}
	
	private getQuestionId(q: AskQuestionDef): string {
		return q.id || q.question;
	}
	
	private isQuestionAnswered(q: AskQuestionDef): boolean {
		const qId = this.getQuestionId(q);
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
		const qId = this.getQuestionId(q);
		
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
					this.toggleOption(q, opt.value);
				});
				
				optionIndex++;
			}
		}
		
		if (q.isOther) {
			const otherEl = optionsList.createDiv({ cls: 'guki-ask-custom-text' });
			if (this.focusedItemIndex === optionIndex) {
				otherEl.addClass('guki-ask-focused');
			}
			
			const inputEl = otherEl.createEl('input', {
				attr: {
					type: q.isSecret ? 'password' : 'text',
					placeholder: 'Other...'
				}
			});
			
			const currentText = this.customTexts[qId] || '';
			inputEl.value = currentText;
			if (currentText.length > 0) {
				otherEl.addClass('guki-ask-selected');
			}
			
			const currentIndex = optionIndex;
			otherEl.addEventListener('click', () => {
				this.focusedItemIndex = currentIndex;
				inputEl.focus();
			});
			
			inputEl.addEventListener('focus', () => {
				this.focusedItemIndex = currentIndex;
				otherEl.addClass('guki-ask-focused');
			});
			
			inputEl.addEventListener('blur', () => {
				otherEl.removeClass('guki-ask-focused');
			});
			
			inputEl.addEventListener('input', (e) => {
				const val = (e.target as HTMLInputElement).value;
				this.customTexts[qId] = val;
				
				if (!q.multiSelect && val.length > 0) {
					this.selections[qId] = [];
				}
				
				this.renderTabBar();
				if (val.length > 0) {
					otherEl.addClass('guki-ask-selected');
				} else {
					otherEl.removeClass('guki-ask-selected');
				}
			});
			
			if (this.focusedItemIndex === optionIndex) {
				window.requestAnimationFrame(() => inputEl.focus());
			}
			optionIndex++;
		}

		if (q.multiSelect || q.isOther) {
			const actionsEl = this.contentEl.createDiv({ cls: 'guki-ask-actions' });
			const isLastQuestion = this.currentTabIndex === this.questions.length - 1;
			const isAnswered = this.isQuestionAnswered(q);
			const actionBtn = actionsEl.createEl('button', {
				cls: 'guki-ask-submit-btn',
				text: isLastQuestion ? 'Submit' : 'Next'
			});
			actionBtn.disabled = !isAnswered;
			actionBtn.addEventListener('click', () => {
				if (!isAnswered) return;
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
	}
	
	private toggleOption(q: AskQuestionDef, value: string) {
		const qId = this.getQuestionId(q);
		let sels = this.selections[qId] || [];
		
		if (q.multiSelect) {
			if (sels.includes(value)) {
				sels = sels.filter(v => v !== value);
			} else {
				sels.push(value);
			}
			this.selections[qId] = sels;
			this.customTexts[qId] = '';
		} else {
			this.selections[qId] = [value];
			this.customTexts[qId] = '';
			
			// Single select: advances if more questions, submits if last question
			if (this.currentTabIndex < this.questions.length - 1) {
				this.currentTabIndex++;
				this.focusedItemIndex = 0;
			} else {
				this.submit();
				return;
			}
		}
		
		this.renderTabBar();
		this.renderTabContent();
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
		const numOptions = (q.options ? q.options.length : 0) + (q.isOther ? 1 : 0);

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
			if (q.options && this.focusedItemIndex >= 0 && this.focusedItemIndex < q.options.length) {
				const opt = q.options[this.focusedItemIndex]!;
				this.toggleOption(q, opt.value);
				return;
			}
			if (q.isOther && this.focusedItemIndex === (q.options ? q.options.length : 0)) {
				const inputEl = this.contentEl.querySelector('input');
				inputEl?.focus();
				return;
			}
			if (isLastQuestion && this.isQuestionAnswered(q)) {
				this.submit();
			}
		}
	}
	
	private submit() {
		const allAnswered = this.questions.every(q => this.isQuestionAnswered(q));
		if (!allAnswered) return;
		
		const finalAnswers: Record<string, string | string[]> = {};
		for (const q of this.questions) {
			const qId = this.getQuestionId(q);
			const sels = this.selections[qId] || [];
			const custom = this.customTexts[qId] || '';
			
			if (q.multiSelect) {
				const ans = [...sels];
				if (custom.trim().length > 0) ans.push(custom);
				finalAnswers[qId] = ans;
			} else {
				if (custom.trim().length > 0) {
					finalAnswers[qId] = custom;
				} else {
					finalAnswers[qId] = sels[0] || '';
				}
			}
		}
		
		this.onDecide(finalAnswers);
	}
	
	destroy(): void {
		this.el.remove();
	}
}

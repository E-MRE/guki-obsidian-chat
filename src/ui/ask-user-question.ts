import { Component, setIcon } from 'obsidian';
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
	private focusedItemIndex = -1; // -1 means focus is on the custom text or nothing
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
		this.el.tabIndex = -1; // To steal focus
		
		this.tabBarEl = this.el.createDiv({ cls: 'guki-ask-tab-bar' });
		this.contentEl = this.el.createDiv({ cls: 'guki-ask-content' });
		
		this.renderTabBar();
		this.renderTabContent();
		
		this.component.registerDomEvent(this.el, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
		
		// Wait for next frame to focus to ensure DOM is ready
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
		if (this.isMalformed) {
			return;
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
		
		// Submit tab
		const submitTab = this.tabBarEl.createDiv({ cls: 'guki-ask-tab' });
		if (this.currentTabIndex === this.questions.length) {
			submitTab.addClass('guki-ask-active');
		}
		
		const allAnswered = this.questions.every(q => this.isQuestionAnswered(q));
		if (allAnswered) {
			submitTab.addClass('guki-ask-answered');
			setIcon(submitTab, 'check');
		} else {
			submitTab.setText('Submit');
		}
		
		submitTab.addEventListener('click', () => {
			this.currentTabIndex = this.questions.length;
			this.focusedItemIndex = -1;
			this.renderTabBar();
			this.renderTabContent();
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
		
		if (this.currentTabIndex >= this.questions.length) {
			this.renderSubmitContent();
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
				this.renderTabContent(); // Re-render to update focus class
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
				
				// Optional: auto-deselect other options if single-select
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
			
			// Auto focus if it's the currently focused item
			if (this.focusedItemIndex === optionIndex) {
				window.requestAnimationFrame(() => inputEl.focus());
			}
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
			
			// Clear custom text if we select a regular option
			this.customTexts[qId] = '';
		} else {
			this.selections[qId] = [value];
			this.customTexts[qId] = '';
			
			// Single select advances automatically
			if (this.currentTabIndex < this.questions.length) {
				this.currentTabIndex++;
				this.focusedItemIndex = 0;
			}
		}
		
		this.renderTabBar();
		this.renderTabContent();
	}
	
	private renderSubmitContent() {
		const allAnswered = this.questions.every(q => this.isQuestionAnswered(q));
		
		this.contentEl.createDiv({ 
			cls: 'guki-ask-question', 
			text: allAnswered ? 'Ready to submit.' : 'Please answer all questions before submitting.' 
		});
		
		const submitBtn = this.contentEl.createEl('button', {
			text: 'Submit answers'
		});
		
		if (!allAnswered) {
			submitBtn.disabled = true;
		}
		
		submitBtn.addEventListener('click', () => {
			this.submit();
		});
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
		
		if (e.key === 'Tab') {
			e.preventDefault();
			if (e.shiftKey) {
				this.currentTabIndex = Math.max(0, this.currentTabIndex - 1);
			} else {
				this.currentTabIndex = Math.min(this.questions.length, this.currentTabIndex + 1);
			}
			this.focusedItemIndex = 0;
			this.renderTabBar();
			this.renderTabContent();
			return;
		}
		
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			if (e.key === 'ArrowLeft') {
				this.currentTabIndex = Math.max(0, this.currentTabIndex - 1);
			} else {
				this.currentTabIndex = Math.min(this.questions.length, this.currentTabIndex + 1);
			}
			this.focusedItemIndex = 0;
			this.renderTabBar();
			this.renderTabContent();
			return;
		}
		
		if (this.currentTabIndex >= this.questions.length) {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.submit();
			}
			return;
		}
		
		const q = this.questions[this.currentTabIndex];
		if (!q) return;
		const numOptions = (q.options ? q.options.length : 0) + (q.isOther ? 1 : 0);
		
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			this.focusedItemIndex = Math.min(numOptions - 1, this.focusedItemIndex + 1);
			if (this.focusedItemIndex === -1 && numOptions > 0) this.focusedItemIndex = 0;
			this.renderTabContent();
			return;
		}
		
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			this.focusedItemIndex = Math.max(0, this.focusedItemIndex - 1);
			this.renderTabContent();
			return;
		}
		
		if (e.key === 'Enter') {
			// If we are currently focusing an input field, let the default enter behavior happen
			if (this.focusedItemIndex >= 0 && this.focusedItemIndex < (q.options ? q.options.length : 0)) {
				e.preventDefault();
				const opt = q.options![this.focusedItemIndex]!;
				this.toggleOption(q, opt.value);
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

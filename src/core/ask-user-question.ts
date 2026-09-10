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
	isSecret?: boolean;
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
		if (typeof qObj.isSecret === 'boolean') {
			def.isSecret = qObj.isSecret;
		}
		
		if (Array.isArray(qObj.options)) {
			const options: AskQuestionOption[] = [];
			for (const opt of qObj.options) {
				if (opt && typeof opt === 'object') {
					const o = opt as Record<string, unknown>;
					if (typeof o.label === 'string' && typeof o.value === 'string') {
						const optObj: AskQuestionOption = {
							label: o.label,
							value: o.value
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

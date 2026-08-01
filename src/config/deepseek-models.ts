/**
 * DeepSeek Model Configuration — single source of truth for all model names.
 * All business code references modes, not raw model strings.
 */

export type AIMode = 'fast' | 'reasoning' | 'max_reasoning';

export interface ModelConfig {
  model: string;
  thinking: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'medium' | 'high' | 'max';
  temperature: number;
}

const MODEL = 'deepseek-v4-flash';

/** Fallback model — only for explicit use, never auto-selected */
export const FALLBACK_MODEL = 'deepseek-v4-pro';

export const MODEL_PRESETS: Record<AIMode, ModelConfig> = {
  fast: {
    model: MODEL,
    thinking: { type: 'disabled' },
    temperature: 0,
  },
  reasoning: {
    model: MODEL,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    temperature: 0.3,
  },
  max_reasoning: {
    model: MODEL,
    thinking: { type: 'enabled' },
    reasoning_effort: 'max',
    temperature: 0.3,
  },
};

/** Which mode to use by task type */
export const TASK_MODES: Record<string, AIMode> = {
  sponsorship_detection: 'fast',
  topic_classification: 'fast',
  comment_classification: 'fast',
  market_inference: 'fast',
  decision_brief: 'reasoning',
  evidence_conflict: 'reasoning',
  article_qa: 'reasoning',
  code_diagnosis: 'max_reasoning',
};

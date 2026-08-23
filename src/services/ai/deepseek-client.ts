/**
 * Unified DeepSeek Client — single entry point for all LLM calls.
 *
 * Three modes via deepseek-v4-flash:
 *   fast:     thinking=disabled, T=0          — classification, extraction
 *   reasoning: thinking=enabled, effort=high   — briefs, analysis, QA
 *   max_reasoning: thinking=enabled, effort=max — complex diagnosis
 *
 * Model pinned to deepseek-v4-flash — no pro fallback.
 */

import axios from 'axios';
import { config } from '../../config';
import {
  MODEL_PRESETS, type AIMode, type ModelConfig,
} from '../../config/deepseek-models';

const BASE_URL = config.deepseek.baseUrl;
const API_KEY = config.deepseek.apiKey;

export interface CallOptions {
  mode?: AIMode;
  maxTokens?: number;
  timeout?: number;
  jsonMode?: boolean;
}

export interface CallResult {
  content: string;
  finishReason: string;
  requestedModel: string;
  returnedModel: string;
  mode: AIMode;
  thinkingEnabled: boolean;
  reasoningContent: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  latencyMs: number;
}

export interface JSONCallResult<T> {
  success: boolean;
  data: T | null;
  error: string;
  diagnostic: Omit<CallResult, 'content'> & { contentPreview: string };
}

/** Core API call */
export async function chat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: CallOptions = {},
): Promise<CallResult> {
  const preset: ModelConfig = MODEL_PRESETS[opts.mode || 'fast'];
  const model = preset.model;
  const maxTokens = opts.maxTokens || (opts.mode === 'reasoning' || opts.mode === 'max_reasoning' ? 8192 : 4096);
  const timeout = opts.timeout || (opts.mode === 'max_reasoning' ? 120_000 : 60_000);

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: preset.temperature,
    max_tokens: maxTokens,
    thinking: { type: preset.thinking.type },
  };

  if (preset.reasoning_effort) {
    (body.thinking as any).effort = preset.reasoning_effort;
  }

  const startMs = Date.now();

  const resp = await axios.post(`${BASE_URL}/chat/completions`, body, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    timeout,
  });

  const choice = resp.data?.choices?.[0];
  const content = choice?.message?.content?.trim() || '';
  const reasoningContent = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
  const usage = resp.data?.usage || {};

  const result: CallResult = {
    content,
    finishReason: choice?.finish_reason || 'unknown',
    requestedModel: model,
    returnedModel: resp.data?.model || '?',
    mode: opts.mode || 'fast',
    thinkingEnabled: preset.thinking.type === 'enabled',
    reasoningContent,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    latencyMs: Date.now() - startMs,
  };

  console.log(`[DS] ${result.mode}: req=${result.requestedModel} ret=${result.returnedModel} finish=${result.finishReason} content=${result.content.length}c reasoning=${result.reasoningContent.length}r tokens=${result.promptTokens}p/${result.completionTokens}c/${result.reasoningTokens}r ${result.latencyMs}ms`);

  return result;
}

/** Call with automatic JSON parsing + empty-content fallback */
export async function chatJSON<T>(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: CallOptions = {},
): Promise<JSONCallResult<T>> {
  // ── Attempt 1: JSON mode ──
  let result: CallResult;
  try {
    result = await chat(messages, { ...opts, jsonMode: true });
  } catch (err) {
    const msg = (err as Error).message;
    // 模型固定 flash，不做 pro fallback —— 直接把错误上抛给调用方。
    return { success: false, data: null, error: `API_CALL_FAILED: ${msg}`, diagnostic: { contentPreview: '', requestedModel: opts.mode || 'fast', returnedModel: '?', mode: opts.mode || 'fast', thinkingEnabled: false, finishReason: 'error', reasoningContent: '', promptTokens: 0, completionTokens: 0, reasoningTokens: 0, latencyMs: 0 } };
  }

  if (!result.content) {
    // ── Attempt 2: Retry without jsonMode, with explicit JSON instructions ──
    console.warn(`[DS] JSON_MODE_EMPTY — retrying without response_format`);
    messages.push({ role: 'user', content: '\n\nOUTPUT ONLY valid JSON. NO markdown, NO code fences, NO explanation. Start with { or [.' });
    try {
      const retryResult = await chat(messages, { mode: 'fast', maxTokens: opts.maxTokens || 4096, timeout: opts.timeout });
      result = retryResult;
    } catch (err) {
      return { success: false, data: null, error: `JSON_RETRY_FAILED: ${(err as Error).message}`, diagnostic: diagnosticFromResult(result) };
    }

    if (!result.content) {
      return { success: false, data: null, error: 'AI_EMPTY_RESPONSE', diagnostic: diagnosticFromResult(result) };
    }
  }

  // Parse JSON with 3-layer extraction
  let parsed: any = null;
  const raw = result.content;
  try { parsed = JSON.parse(raw); } catch {}
  if (parsed === null) {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) try { parsed = JSON.parse(m[1]); } catch {}
  }
  if (parsed === null) {
    const isArr = raw.trim().startsWith('[');
    const start = raw.indexOf(isArr ? '[' : '{');
    const end = raw.lastIndexOf(isArr ? ']' : '}');
    if (start >= 0 && end > start) try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch {}
  }

  if (parsed === null) {
    return { success: false, data: null, error: `JSON_PARSE_FAILED(contentLen=${raw.length})`, diagnostic: diagnosticFromResult(result) };
  }

  return { success: true, data: parsed as T, error: '', diagnostic: diagnosticFromResult(result) };
}

function diagnosticFromResult(r: CallResult) {
  return {
    contentPreview: r.content.slice(0, 500),
    requestedModel: r.requestedModel,
    returnedModel: r.returnedModel,
    mode: r.mode,
    thinkingEnabled: r.thinkingEnabled,
    finishReason: r.finishReason,
    reasoningContent: r.reasoningContent.slice(0, 200),
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    reasoningTokens: r.reasoningTokens,
    latencyMs: r.latencyMs,
  };
}

// ── Test functions ──
export async function testFastMode(): Promise<{ passed: boolean; details: string }> {
  console.log('[DS Test] fast mode...');
  const result = await chat([{ role: 'user', content: 'Say "OK" in JSON: {"status":"ok"}' }], { mode: 'fast', maxTokens: 256 });
  const checks: string[] = [];
  if (result.requestedModel !== 'deepseek-v4-flash') checks.push(`wrong model: ${result.requestedModel}`);
  if (result.reasoningContent.length > 0) checks.push(`reasoning present: ${result.reasoningContent.length} chars`);
  if (!result.content) checks.push('empty content');
  try { JSON.parse(result.content); } catch { checks.push('invalid JSON'); }
  const passed = checks.length === 0;
  console.log(`[DS Test] fast: ${passed ? 'PASS' : 'FAIL: ' + checks.join(', ')}`);
  return { passed, details: checks.join('; ') || 'OK' };
}

export async function testReasoningMode(): Promise<{ passed: boolean; details: string }> {
  console.log('[DS Test] reasoning mode...');
  const result = await chat([{ role: 'user', content: 'Explain why 2+2=4 in one sentence.' }], { mode: 'reasoning', maxTokens: 1024 });
  const checks: string[] = [];
  if (result.requestedModel !== 'deepseek-v4-flash') checks.push(`wrong model: ${result.requestedModel}`);
  if (!result.reasoningContent) checks.push('no reasoning_content');
  if (!result.content) checks.push('empty content');
  const passed = checks.length === 0;
  console.log(`[DS Test] reasoning: ${passed ? 'PASS' : 'FAIL: ' + checks.join(', ')}`);
  return { passed, details: checks.join('; ') || 'OK' };
}

export async function runAllTests(): Promise<{ allPassed: boolean; results: Record<string, { passed: boolean; details: string }> }> {
  const fast = await testFastMode();
  const reasoning = await testReasoningMode();
  return { allPassed: fast.passed && reasoning.passed, results: { fast, reasoning } };
}

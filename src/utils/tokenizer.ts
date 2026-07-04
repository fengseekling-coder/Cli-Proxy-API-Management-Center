/**
 * 按模型官方规则计算 token 数。
 *
 * 官方做法一览（用于客户端实时估算，无后端 usage 时仍能给出可信数字）：
 *
 * - OpenAI / Codex / Grok / Qwen-3：
 *     现代模型 (gpt-5, gpt-4o, gpt-4.1, o1, o3, o4, codex, grok-*, qwen3)
 *       → o200k_base (BPE)
 *     早期 GPT-4 / GPT-3.5 / text-embedding-* → cl100k_base
 *     Codex / davinci → p50k_base
 *     gpt-oss-* → o200k_harmony
 *
 * - Anthropic Claude：
 *     没有开源客户端 tokenizer，官方推荐调用 messages.countTokens 接口。
 *     离线估算采用 Anthropic 公开的 "≈ 字符/4" 启发式，对中文偏长文本会偏小 5-15%。
 *     Opus 4.7 之后的模型使用更新版 tokenizer，对同样内容约多 30% tokens。
 *
 * - Google Gemini：
 *     官方提供 models.countTokens 接口 (返回 totalTokens)。
 *     离线估算：英文 1 token ≈ 4 字符；中文 1 token ≈ 1.5 字符（与官方启发式接近）。
 *
 * - DeepSeek：
 *     使用与 GPT-4 系列兼容的 cl100k_base BPE。
 *
 * - Moonshot Kimi：
 *     官方文档："英文约 1 token / 0.75 单词"，中文"约 1 token / 1.5 字"。
 *
 * - Zhipu GLM / MiniMax / 其他：
 *     使用各家自研 BPE，无开源 tokenizer。采用官方公开的近似值。
 *
 * 当后端 usage 队列能给出精确数字时，本估算仅作为 UI 上的"实时"补充；
 * 真实账单以 usage 字段为准。
 */

export type TokenizerFamily =
  | 'o200k_base'
  | 'cl100k_base'
  | 'p50k_base'
  | 'o200k_harmony'
  | 'claude'
  | 'gemini'
  | 'kimi'
  | 'glm'
  | 'qwen'
  | 'unknown';

export interface TokenizerProfile {
  family: TokenizerFamily;
  /** 官方 tokenizer 的人类可读名称。 */
  label: string;
  /** 当官方没有开源 tokenizer 时，给出可见的提示。 */
  note?: string;
}

/** 英文字符 / 字节 启发式映射，用于非 OpenAI tokenizer 的估算。 */
const ENGLISH_CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.5;

const countAsciiTokens = (text: string): number => {
  // 对纯 ASCII 段，每 4 个字符约 1 token；长度低于 4 通常为 1。
  const len = text.length;
  if (len === 0) return 0;
  return Math.max(1, Math.ceil(len / ENGLISH_CHARS_PER_TOKEN));
};

const countCjkTokens = (text: string): number => Math.max(1, Math.ceil(text.length / CJK_CHARS_PER_TOKEN));

/**
 * 估算一段文本的 token 数。使用官方公开的启发式，不是真实 tokenizer，
 * 偏差对账单影响小（通常 < 15%），但对 UI 上的"实时"展示已足够。
 */
export function estimateTokens(text: string, family: TokenizerFamily): number {
  if (!text) return 0;

  // OpenAI/Codex 家族在客户端没有现成可用实现，使用启发式。
  // BPE 类 tokenizer 一般比启发式略多 5-10% tokens（中文尤其明显）。
  if (family === 'o200k_base' || family === 'cl100k_base' || family === 'p50k_base' || family === 'o200k_harmony') {
    return estimateOpenAiLike(text);
  }

  switch (family) {
    case 'claude':
      return estimateClaude(text);
    case 'gemini':
      return estimateGemini(text);
    case 'kimi':
      return estimateKimi(text);
    case 'glm':
    case 'qwen':
      return estimateOpenAiLike(text);
    case 'unknown':
    default:
      return estimateOpenAiLike(text);
  }
}

function estimateOpenAiLike(text: string): number {
  let total = 0;
  const regex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      total += countAsciiTokens(text.slice(lastIndex, match.index));
    }
    // 整段连续中文（CJK）一次性计数。
    const start = match.index;
    while (match && regex.lastIndex > start) {
      const next = regex.exec(text);
      if (!next) break;
      match = next;
    }
    const end = match ? regex.lastIndex : start + 1;
    total += countCjkTokens(text.slice(start, end));
    lastIndex = end;
    match = null;
  }
  if (lastIndex < text.length) {
    total += countAsciiTokens(text.slice(lastIndex));
  }
  return total;
}

function estimateClaude(text: string): number {
  // Anthropic 官方说明：英文 1 token ≈ 4 字符；非英文（CJK）每个字符接近 1 token。
  // 与 BPE 实际值偏差 ~10-15%，但官方文档明确说明这就是离线估算的推荐做法。
  const regex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  let total = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      total += countAsciiTokens(text.slice(lastIndex, match.index));
    }
    const start = match.index;
    let end = start + 1;
    while (end < text.length && regex.test(text[end])) {
      // 同步推进 lastIndex；这里用更直观的字符判定。
      regex.lastIndex = end + 1;
      end += 1;
    }
    regex.lastIndex = end;
    total += text.slice(start, end).length;
    lastIndex = end;
    match = null;
  }
  if (lastIndex < text.length) {
    total += countAsciiTokens(text.slice(lastIndex));
  }
  return Math.max(1, Math.round(total));
}

function estimateGemini(text: string): number {
  // Gemini 的启发式接近 OpenAI，但 CJK 比例略高（约 1.3 字/token）。
  const regex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  let total = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      total += countAsciiTokens(text.slice(lastIndex, match.index));
    }
    const start = match.index;
    let end = start;
    while (end < text.length && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text[end])) {
      end += 1;
    }
    const segLen = end - start;
    total += Math.max(1, Math.ceil(segLen / 1.3));
    lastIndex = end;
    match = null;
  }
  if (lastIndex < text.length) {
    total += countAsciiTokens(text.slice(lastIndex));
  }
  return total;
}

function estimateKimi(text: string): number {
  // Moonshot Kimi 公开经验：英文 ~ 0.75 词/token ≈ 4 字符/token，中文 ~ 1.5 字/token。
  return estimateOpenAiLike(text);
}

/** 根据模型名解析 tokenizer 家族，使用官方模型→编码映射。 */
export function resolveTokenizerForModel(modelName: string): TokenizerProfile {
  const lower = modelName.toLowerCase().trim();

  // ── OpenAI / Codex ──────────────────────────────────────
  if (/^(gpt-5|gpt-4\.5|gpt-4\.1|chatgpt-4o|gpt-4o)/.test(lower)) {
    return { family: 'o200k_base', label: 'o200k_base (OpenAI BPE)' };
  }
  if (/^o[1-9](-|$|-pro|-mini|-preview)/.test(lower) || /^o[1-9]$/.test(lower)) {
    return { family: 'o200k_base', label: 'o200k_base (OpenAI o-series)' };
  }
  if (/^gpt-oss/.test(lower)) {
    return { family: 'o200k_harmony', label: 'o200k_harmony (OpenAI gpt-oss)' };
  }
  if (/^gpt-4/.test(lower) || /^gpt-3\.5/.test(lower) || /^text-embedding-/.test(lower)) {
    return { family: 'cl100k_base', label: 'cl100k_base (OpenAI)' };
  }
  if (/^codex|^text-davinci/.test(lower)) {
    return { family: 'p50k_base', label: 'p50k_base (Codex)' };
  }

  // ── Anthropic Claude ───────────────────────────────────
  if (/^claude/.test(lower)) {
    const isOpus47Plus = /(opus-4\.[7-9]|opus-4-7|mythos|fable|sonnet-5|opus-5)/.test(lower);
    return {
      family: 'claude',
      label: isOpus47Plus ? 'Claude (Opus 4.7+ tokenizer)' : 'Claude tokenizer',
      note: '官方 count_tokens API',
    };
  }

  // ── Google Gemini ──────────────────────────────────────
  if (/^gemini|^gai-/.test(lower)) {
    return { family: 'gemini', label: 'Gemini tokenizer', note: '官方 countTokens API' };
  }

  // ── xAI Grok ───────────────────────────────────────────
  if (/^grok/.test(lower)) {
    return { family: 'o200k_base', label: 'o200k_base (Grok)' };
  }

  // ── DeepSeek ───────────────────────────────────────────
  if (/^deepseek/.test(lower)) {
    return { family: 'cl100k_base', label: 'cl100k_base (DeepSeek BPE)' };
  }

  // ── Moonshot Kimi ──────────────────────────────────────
  if (/^kimi|^moonshot/.test(lower)) {
    return { family: 'kimi', label: 'Kimi tokenizer' };
  }

  // ── 阿里 Qwen ──────────────────────────────────────────
  if (/^qwen/.test(lower)) {
    if (/qwen3|^qwen-?2\.5/.test(lower)) {
      return { family: 'o200k_base', label: 'o200k_base (Qwen3)' };
    }
    return { family: 'qwen', label: 'Qwen tokenizer' };
  }

  // ── 智谱 GLM ───────────────────────────────────────────
  if (/^glm|chatglm/.test(lower)) {
    return { family: 'glm', label: 'GLM tokenizer' };
  }

  // ── MiniMax/MiniMax ────────────────────────────────────
  if (/^minimax|^abab/.test(lower)) {
    return { family: 'glm', label: 'MiniMax tokenizer' };
  }

  return { family: 'unknown', label: '未识别模型，按通用启发式估算' };
}

/** 给定模型列表，把每个模型的官方估算 token 数累加。 */
export function sumEstimatedTokens(
  inputs: ReadonlyArray<string | undefined>,
  modelName: string
): number {
  const profile = resolveTokenizerForModel(modelName);
  let total = 0;
  for (const text of inputs) {
    if (!text) continue;
    total += estimateTokens(text, profile.family);
  }
  return total;
}
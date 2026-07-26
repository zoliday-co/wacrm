import { AiError, type AiUsage, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared';

// ============================================================
// Google Gemini adapter.
//
// Raw fetch against the Generative Language REST API — deliberately
// no `@google/genai` SDK: the OpenAI and Anthropic adapters are both
// SDK-free fetch calls, and a BYO-key multi-tenant server wants zero
// per-provider dependencies. Same key-handling, error-mapping, and
// usage-normalization patterns as the other two.
//
// Two entry points:
//   - generateGemini: plain single-shot chat, used by `generateReply`
//     for accounts on provider='gemini' (and the settings key test).
//   - generateGeminiToolLoop: multi-round function-calling loop, used
//     by the Oliday agent for search_packages / get_package. Kept in
//     the adapter because the request/response wire shape is
//     Gemini-specific; the tool DEFINITIONS come from the caller.
// ============================================================

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** A callable tool: JSON-Schema declaration + server-side executor.
 *  The executor's return value is serialized into the functionResponse
 *  part, so return plain JSON-safe data. */
export interface GeminiTool {
  name: string;
  description: string;
  /** JSON Schema (OpenAPI subset Gemini accepts) for the arguments. */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

async function callGemini(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<GeminiResponse> {
  let res: Response;
  try {
    res = await fetch(
      `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
  } catch (err) {
    throw toNetworkError(err);
  }
  if (!res.ok) {
    throw await providerHttpError('Gemini', res);
  }
  const data = (await res.json().catch(() => null)) as GeminiResponse | null;
  if (!data) {
    throw new AiError('Gemini returned a non-JSON response.', {
      code: 'provider_error',
    });
  }
  return data;
}

function toGeminiContents(messages: ProviderArgs['messages']): GeminiContent[] {
  // Gemini uses 'model' for the assistant role and, like Anthropic,
  // behaves best with alternating roles — reuse the shared merge.
  return mergeConsecutive(messages).map((m) => ({
    role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
    parts: [{ text: m.content }],
  }));
}

function usageOf(data: GeminiResponse): AiUsage | null {
  return normalizeUsage({
    prompt: data.usageMetadata?.promptTokenCount,
    completion: data.usageMetadata?.candidatesTokenCount,
    total: data.usageMetadata?.totalTokenCount,
  });
}

function sumUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function textOf(parts: GeminiPart[] | undefined): string {
  return (parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}

/** Plain chat — the `generateReply` path for provider='gemini'. */
export async function generateGemini(
  args: ProviderArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args;

  const data = await callGemini(
    apiKey,
    model,
    {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: toGeminiContents(messages),
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    timeoutMs
  );

  const text = textOf(data.candidates?.[0]?.content?.parts);
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    });
  }
  return { text, usage: usageOf(data) };
}

export interface GeminiToolLoopArgs extends ProviderArgs {
  tools: GeminiTool[];
  /** Hard cap on tool rounds — a runaway model can't loop forever.
   *  Each round may contain several parallel calls. */
  maxToolRounds?: number;
  temperature?: number;
}

export interface GeminiToolLoopResult {
  text: string;
  usage: AiUsage | null;
  /** Every tool invocation the model made, in order — the caller
   *  logs these and mines them (e.g. shown packages) for state. */
  toolCalls: { name: string; args: Record<string, unknown>; result: unknown }[];
}

/**
 * Function-calling loop: send → (model calls tools → execute → send
 * results back)* → final text. Executor failures are returned TO THE
 * MODEL as `{ error }` rather than thrown, so one flaky catalog query
 * degrades into the model apologising / handing off instead of the
 * whole turn dying.
 */
export async function generateGeminiToolLoop(
  args: GeminiToolLoopArgs
): Promise<GeminiToolLoopResult> {
  const {
    apiKey,
    model,
    systemPrompt,
    messages,
    timeoutMs,
    tools,
    maxToolRounds = 4,
    temperature,
  } = args;

  const contents: GeminiContent[] = toGeminiContents(messages);
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: [
      {
        functionDeclarations: tools.map(
          ({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })
        ),
      },
    ],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(temperature !== undefined ? { temperature } : {}),
    },
  };

  let usage: AiUsage | null = null;
  const toolCalls: GeminiToolLoopResult['toolCalls'] = [];

  for (let round = 0; round <= maxToolRounds; round++) {
    const data = await callGemini(
      apiKey,
      model,
      { ...body, contents },
      timeoutMs
    );
    usage = sumUsage(usage, usageOf(data));

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter(
      (p): p is Required<Pick<GeminiPart, 'functionCall'>> & GeminiPart =>
        Boolean(p.functionCall?.name)
    );

    if (calls.length === 0 || round === maxToolRounds) {
      const text = textOf(parts);
      if (!text) {
        throw new AiError('Gemini returned an empty response.', {
          code: 'empty_response',
        });
      }
      return { text, usage, toolCalls };
    }

    // Echo the model turn, then answer every call in one user turn.
    contents.push({ role: 'model', parts });
    const responses: GeminiPart[] = [];
    for (const call of calls) {
      const name = call.functionCall.name;
      const callArgs = call.functionCall.args ?? {};
      const tool = tools.find((t) => t.name === name);
      let result: unknown;
      if (!tool) {
        result = { error: `unknown tool: ${name}` };
      } else {
        try {
          result = await tool.execute(callArgs);
        } catch (err) {
          result = {
            error: err instanceof Error ? err.message : 'tool execution failed',
          };
        }
      }
      toolCalls.push({ name, args: callArgs, result });
      responses.push({
        functionResponse: {
          name,
          // functionResponse.response must be an OBJECT — wrap
          // arrays/primitives so valid tool output never 400s.
          response:
            result !== null &&
            typeof result === 'object' &&
            !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : { result },
        },
      });
    }
    contents.push({ role: 'user', parts: responses });
  }

  // Unreachable — the loop always returns on its final round.
  throw new AiError('Gemini tool loop did not produce a reply.', {
    code: 'provider_error',
  });
}

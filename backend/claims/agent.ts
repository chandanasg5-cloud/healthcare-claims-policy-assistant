import { stepLabel } from "./toolspec";

export interface ChatMessage {
  role: "user" | "model";
  text: string;
}

export interface SourceChunk {
  id: string;
  source: string;
  text: string;
}

export type AgentEvent =
  | { type: "step"; tool: string; label: string }
  | { type: "sources"; chunks: SourceChunk[] }
  | { type: "text"; text: string };

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface GenPart {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: { name: string; response: { output: string } };
}

export interface GenContent {
  role: "user" | "model";
  parts: GenPart[];
}

export interface RoundChunk {
  text?: string;
  functionCalls?: FunctionCall[];
}

export interface ModelClient {
  streamRound(contents: GenContent[]): AsyncGenerator<RoundChunk>;
}

export interface ToolOutcome {
  output: string;
  sources?: SourceChunk[];
}

export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

export const MAX_ROUNDS = 6;
export const MAX_CALLS_PER_ROUND = 3;
export const HISTORY_LIMIT = 20;

// One agent conversation: streams model rounds, executes tool calls between
// rounds, and yields UI events. The model client and tool runner are injected
// so the loop is unit-testable without network or database.
export async function* chatStream(
  history: ChatMessage[],
  model: ModelClient,
  runTool: ToolRunner,
): AsyncGenerator<AgentEvent> {
  // Truncate, then drop any leading model turns the cut exposed — Gemini
  // expects conversations to open with a user message.
  const recent = history.slice(-HISTORY_LIMIT);
  while (recent.length > 0 && recent[0].role === "model") recent.shift();
  const contents: GenContent[] = recent.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const isLastRound = round === MAX_ROUNDS;
    if (isLastRound) {
      contents.push({
        role: "user",
        parts: [{ text: "Answer now from the information already gathered. Do not call any more tools." }],
      });
    }

    let roundText = "";
    const calls: FunctionCall[] = [];
    for await (const chunk of model.streamRound(contents)) {
      if (chunk.text) {
        roundText += chunk.text;
        yield { type: "text", text: chunk.text };
      }
      if (chunk.functionCalls && !isLastRound) calls.push(...chunk.functionCalls);
    }
    if (calls.length === 0) return;

    const modelParts: GenPart[] = [];
    if (roundText) modelParts.push({ text: roundText });
    for (const c of calls) modelParts.push({ functionCall: c });
    contents.push({ role: "model", parts: modelParts });

    const responseParts: GenPart[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (i >= MAX_CALLS_PER_ROUND) {
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { output: "Error: too many tool calls in one round; use at most 3." },
          },
        });
        continue;
      }
      yield { type: "step", tool: call.name, label: stepLabel(call.name, call.args) };
      let outcome: ToolOutcome;
      try {
        outcome = await runTool(call.name, call.args);
      } catch (err) {
        outcome = { output: `Error: tool failed: ${err instanceof Error ? err.message : "unknown error"}` };
      }
      if (outcome.sources?.length) yield { type: "sources", chunks: outcome.sources };
      responseParts.push({ functionResponse: { name: call.name, response: { output: outcome.output } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }
}

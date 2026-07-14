import { describe, it, expect } from "vitest";
import {
  chatStream, MAX_ROUNDS, HISTORY_LIMIT,
  type AgentEvent, type GenContent, type ModelClient, type RoundChunk, type ToolRunner,
} from "./agent";

// Fake model: pops one scripted round per streamRound call; records contents.
function fakeModel(rounds: RoundChunk[][]): ModelClient & { seen: GenContent[][] } {
  const seen: GenContent[][] = [];
  return {
    seen,
    async *streamRound(contents: GenContent[]) {
      seen.push(structuredClone(contents));
      for (const chunk of rounds.shift() ?? [{ text: "fallback answer" }]) yield chunk;
    },
  };
}

const echoTool: ToolRunner = async (name, args) => ({
  output: `${name}:${JSON.stringify(args)}`,
  ...(name === "search_policies"
    ? { sources: [{ id: "timely-filing.md#0", source: "timely-filing.md", text: "calendar year" }] }
    : {}),
});

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("chatStream", () => {
  it("streams a plain text answer when the model calls no tools", async () => {
    const model = fakeModel([[{ text: "Hello " }, { text: "analyst." }]]);
    const events = await drain(chatStream([{ role: "user", text: "hi" }], model, echoTool));
    expect(events).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "analyst." },
    ]);
    expect(model.seen.length).toBe(1);
  });

  it("runs a tool round-trip: step event, sources event, result fed back, final answer", async () => {
    const model = fakeModel([
      [{ functionCalls: [{ name: "search_policies", args: { query: "timely filing" } }] }],
      [{ text: "Per policy, 12 months." }],
    ]);
    const events = await drain(chatStream([{ role: "user", text: "deadline?" }], model, echoTool));
    expect(events[0]).toEqual({ type: "step", tool: "search_policies", label: "Searching policies: timely filing" });
    expect(events[1].type).toBe("sources");
    expect(events[2]).toEqual({ type: "text", text: "Per policy, 12 months." });
    // Round 2 must include the functionCall turn and a functionResponse turn.
    const round2 = model.seen[1];
    const flat = JSON.stringify(round2);
    expect(flat).toContain("functionCall");
    expect(flat).toContain("functionResponse");
    expect(flat).toContain("search_policies");
  });

  it("feeds tool-runner exceptions back to the model as error output instead of throwing", async () => {
    const model = fakeModel([
      [{ functionCalls: [{ name: "get_claim", args: { claimId: "CLM-1" } }] }],
      [{ text: "Could not look that up." }],
    ]);
    const boom: ToolRunner = async () => { throw new Error("db down"); };
    const events = await drain(chatStream([{ role: "user", text: "x" }], model, boom));
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(JSON.stringify(model.seen[1])).toContain("db down");
  });

  it("rejects calls beyond MAX_CALLS_PER_ROUND with an error response, without running them", async () => {
    let runs = 0;
    const counting: ToolRunner = async () => { runs++; return { output: "ok" }; };
    const model = fakeModel([
      [{ functionCalls: [
        { name: "get_claim", args: { claimId: "a" } },
        { name: "get_claim", args: { claimId: "b" } },
        { name: "get_claim", args: { claimId: "c" } },
        { name: "get_claim", args: { claimId: "d" } },
      ] }],
      [{ text: "done" }],
    ]);
    const events = await drain(chatStream([{ role: "user", text: "x" }], model, counting));
    expect(runs).toBe(3);
    expect(events.filter((e) => e.type === "step").length).toBe(3);
    expect(JSON.stringify(model.seen[1])).toContain("too many tool calls");
  });

  it("forces a final tool-free answer at MAX_ROUNDS", async () => {
    const toolRound: RoundChunk[] = [{ functionCalls: [{ name: "get_claim", args: { claimId: "CLM-1" } }] }];
    const rounds: RoundChunk[][] = [];
    for (let i = 0; i < MAX_ROUNDS - 1; i++) rounds.push(structuredClone(toolRound));
    rounds.push([{ text: "final forced answer" }, { functionCalls: [{ name: "get_claim", args: { claimId: "ignored" } }] }]);
    const model = fakeModel(rounds);
    const events = await drain(chatStream([{ role: "user", text: "x" }], model, echoTool));
    expect(model.seen.length).toBe(MAX_ROUNDS);
    const last = model.seen[MAX_ROUNDS - 1];
    expect(JSON.stringify(last.at(-1))).toContain("Do not call any more tools");
    expect(events.filter((e) => e.type === "step").length).toBe(MAX_ROUNDS - 1);
    expect(events.at(-1)).toEqual({ type: "text", text: "final forced answer" });
  });

  it("truncates history to HISTORY_LIMIT messages", async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "model") as "user" | "model",
      text: `m${i}`,
    }));
    const model = fakeModel([[{ text: "ok" }]]);
    await drain(chatStream(long, model, echoTool));
    expect(model.seen[0].length).toBe(HISTORY_LIMIT);
    expect(JSON.stringify(model.seen[0][0])).toContain("m10");
  });
});

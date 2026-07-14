// Pure tool metadata shared by the agent loop, the Gemini client, and the
// executors. No encore/db imports — unit-testable without a database.

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "OBJECT";
    properties: Record<string, { type: "STRING"; description: string }>;
    required: string[];
  };
}

export const toolDeclarations: ToolDeclaration[] = [
  {
    name: "get_claim",
    description: "Look up a single claim by id, including status and denial details.",
    parameters: {
      type: "OBJECT",
      properties: { claimId: { type: "STRING", description: "Claim id, e.g. CLM-1003" } },
      required: ["claimId"],
    },
  },
  {
    name: "get_patient_claims",
    description: "List all claims for one patient.",
    parameters: {
      type: "OBJECT",
      properties: { patientId: { type: "STRING", description: "Patient id, e.g. PAT-002" } },
      required: ["patientId"],
    },
  },
  {
    name: "find_similar_denied",
    description: "Find other claims denied with the same denial code as the given claim.",
    parameters: {
      type: "OBJECT",
      properties: { claimId: { type: "STRING", description: "Reference denied claim id" } },
      required: ["claimId"],
    },
  },
  {
    name: "search_policies",
    description:
      "Full-text search the CMS policy corpus (coverage rules, prior authorization, appeals, timely filing, network rules). Always use before citing a policy.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "Search terms, e.g. 'prior authorization MRI'" } },
      required: ["query"],
    },
  },
  {
    name: "claims_overview",
    description: "Aggregate claim counts and billed totals by status and denial code.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
];

export function validateToolArgs(
  name: string,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const decl = toolDeclarations.find((d) => d.name === name);
  if (!decl) return { ok: false, error: `unknown tool ${name}` };
  for (const req of decl.parameters.required) {
    const v = args[req];
    if (typeof v !== "string" || v.trim() === "") {
      return { ok: false, error: `missing or empty argument ${req} for ${name}` };
    }
  }
  return { ok: true };
}

export function stepLabel(name: string, args: Record<string, unknown>): string {
  const a = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "?");
  switch (name) {
    case "get_claim": return `Looking up claim ${a("claimId")}`;
    case "get_patient_claims": return `Fetching claims for patient ${a("patientId")}`;
    case "find_similar_denied": return `Finding claims similar to ${a("claimId")}`;
    case "search_policies": return `Searching policies: ${a("query")}`;
    case "claims_overview": return "Computing claims overview";
    default: return `Running ${name}`;
  }
}

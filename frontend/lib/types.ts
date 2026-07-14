export interface ChatMessage {
  role: "user" | "model";
  text: string;
}

export interface SourceChunk {
  id: string;
  source: string;
  text: string;
}

export type ChatEvent =
  | { type: "step"; tool: string; label: string }
  | { type: "sources"; chunks: SourceChunk[] }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface ClaimRow {
  claim_id: string;
  patient_id: string;
  date_of_service: string;
  procedure_code: string;
  procedure_desc: string;
  diagnosis_code: string;
  billed_amount: string;
  status: string;
  denial_code: string;
  denial_reason: string;
}

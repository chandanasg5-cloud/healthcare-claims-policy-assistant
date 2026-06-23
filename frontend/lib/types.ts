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

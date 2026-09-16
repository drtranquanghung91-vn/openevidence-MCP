export type OpenEvidenceModel = "osler" | "sackett" | "snow";
export const OPENEVIDENCE_MODELS: readonly OpenEvidenceModel[] = ["osler", "sackett", "snow"];

export interface OpenEvidenceAskRequest {
  question: string;
  originalArticleId?: string;
  /** OpenEvidence answer model; defaults to "osler" when omitted. */
  model?: OpenEvidenceModel;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface AuthStatusResult {
  authenticated: boolean;
  statusCode: number;
  user?: Record<string, unknown>;
  message?: string;
}


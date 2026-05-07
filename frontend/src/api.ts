import type {
  Asset,
  AssetType,
  BrainProviderHealth,
  ChallengerResponse,
  Comparison,
  CreativeBrief,
  LearningSummary,
  Outcome,
  OutcomeCreate,
  Report
} from "./types";

const localViteApi = import.meta.env.DEV && globalThis.location?.port === "5173" ? "http://localhost:8000" : "/api";
const API_BASE = import.meta.env.VITE_API_BASE ?? localViteApi;
const WORKSPACE_KEY = "stimli.workspace";

export async function seedDemo(): Promise<Asset[]> {
  const response = await fetch(`${API_BASE}/demo/seed`, { method: "POST", headers: workspaceHeaders() });
  return parseResponse(response);
}

export async function listAssets(): Promise<Asset[]> {
  const response = await fetch(`${API_BASE}/assets`, { headers: workspaceHeaders() });
  return parseResponse(response);
}

export async function createTextAsset(input: {
  assetType: AssetType;
  name: string;
  text: string;
  url?: string;
  durationSeconds?: number;
  file?: File | null;
}): Promise<Asset> {
  const form = new FormData();
  form.append("asset_type", input.assetType);
  form.append("name", input.name);
  if (input.text) form.append("text", input.text);
  if (input.url) form.append("url", input.url);
  if (input.durationSeconds) form.append("duration_seconds", String(input.durationSeconds));
  if (input.file) form.append("file", input.file);
  const response = await fetch(`${API_BASE}/assets`, { method: "POST", headers: workspaceHeaders(), body: form });
  const payload = await parseResponse<{ asset: Asset }>(response);
  return payload.asset;
}

export async function createComparison(assetIds: string[], objective: string): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/comparisons`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ asset_ids: assetIds, objective })
  });
  return parseResponse(response);
}

export async function createBriefComparison(assetIds: string[], objective: string, brief: CreativeBrief): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/comparisons`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ asset_ids: assetIds, objective, brief })
  });
  return parseResponse(response);
}

export async function listComparisons(): Promise<Comparison[]> {
  const response = await fetch(`${API_BASE}/comparisons`, { headers: workspaceHeaders() });
  return parseResponse(response);
}

export async function getReport(comparisonId: string): Promise<Report> {
  const response = await fetch(`${API_BASE}/reports/${comparisonId}`, { headers: workspaceHeaders() });
  return parseResponse(response);
}

export async function getReportMarkdown(comparisonId: string): Promise<string> {
  const response = await fetch(`${API_BASE}/reports/${comparisonId}/markdown`, { headers: workspaceHeaders() });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return response.text();
}

export async function createOutcome(comparisonId: string, outcome: OutcomeCreate): Promise<Outcome> {
  const response = await fetch(`${API_BASE}/comparisons/${comparisonId}/outcomes`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(outcome)
  });
  return parseResponse(response);
}

export async function createChallenger(
  comparisonId: string,
  input: { source_asset_id?: string | null; focus: "hook" | "cta" | "offer" | "clarity" }
): Promise<ChallengerResponse> {
  const response = await fetch(`${API_BASE}/comparisons/${comparisonId}/challengers`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function getLearningSummary(): Promise<LearningSummary> {
  const response = await fetch(`${API_BASE}/learning/summary`, { headers: workspaceHeaders() });
  return parseResponse(response);
}

export async function getBrainProviders(): Promise<BrainProviderHealth[]> {
  const response = await fetch(`${API_BASE}/brain/providers`);
  return parseResponse(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function jsonHeaders(): HeadersInit {
  return {
    ...workspaceHeaders(),
    "Content-Type": "application/json"
  };
}

function workspaceHeaders(): HeadersInit {
  return { "X-Stimli-Workspace": getWorkspaceId() };
}

function getWorkspaceId(): string {
  if (typeof window === "undefined") {
    return "public";
  }
  const existing = window.localStorage.getItem(WORKSPACE_KEY);
  if (existing) {
    return existing;
  }
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "") ?? `${Date.now()}${Math.random()}`.replace(/\D/g, "");
  const workspaceId = `ws_${random.slice(0, 32)}`;
  window.localStorage.setItem(WORKSPACE_KEY, workspaceId);
  return workspaceId;
}

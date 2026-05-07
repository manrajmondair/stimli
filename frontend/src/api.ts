import { upload } from "@vercel/blob/client";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  Asset,
  AssetType,
  AuthSession,
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
const TEAM_WORKSPACE_KEY = "stimli.team_workspace";

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
  if (input.file && shouldUseDirectBlobUpload()) {
    const blob = await upload(blobPath(input.file.name), input.file, {
      access: "private",
      handleUploadUrl: `${API_BASE}/blob/upload`,
      clientPayload: JSON.stringify({ workspace_id: getWorkspaceId() }),
      contentType: input.file.type || undefined,
      multipart: input.file.size > 8 * 1024 * 1024
    });
    const fileText = input.text || (input.assetType === "script" ? await input.file.text() : "");
    const response = await fetch(`${API_BASE}/assets`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        asset_type: input.assetType,
        name: input.name,
        text: fileText,
        url: input.url,
        duration_seconds: input.durationSeconds,
        blob: {
          ...blob,
          original_filename: input.file.name,
          file_size: input.file.size,
          content_type: input.file.type || "application/octet-stream"
        }
      })
    });
    const payload = await parseResponse<{ asset: Asset }>(response);
    return payload.asset;
  }
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

export async function getComparison(comparisonId: string): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/comparisons/${comparisonId}`, { headers: workspaceHeaders() });
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

export async function getSession(): Promise<AuthSession> {
  const response = await fetch(`${API_BASE}/auth/session`, { credentials: "include" });
  const session = await parseResponse<AuthSession>(response);
  setAuthenticatedWorkspace(session.team?.id || null);
  return session;
}

export async function registerWithPasskey(input: { email: string; name: string; teamName: string }): Promise<AuthSession> {
  const optionsResponse = await fetch(`${API_BASE}/auth/register/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email: input.email, name: input.name, team_name: input.teamName })
  });
  const optionsPayload = await parseResponse<{ challenge_id: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
    optionsResponse
  );
  const credential = await startRegistration({ optionsJSON: optionsPayload.options });
  const verifyResponse = await fetch(`${API_BASE}/auth/register/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ challenge_id: optionsPayload.challenge_id, response: credential })
  });
  const session = await parseResponse<AuthSession>(verifyResponse);
  setAuthenticatedWorkspace(session.team?.id || null);
  return session;
}

export async function loginWithPasskey(email: string): Promise<AuthSession> {
  const optionsResponse = await fetch(`${API_BASE}/auth/login/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email })
  });
  const optionsPayload = await parseResponse<{ challenge_id: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
    optionsResponse
  );
  const credential = await startAuthentication({ optionsJSON: optionsPayload.options });
  const verifyResponse = await fetch(`${API_BASE}/auth/login/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ challenge_id: optionsPayload.challenge_id, response: credential })
  });
  const session = await parseResponse<AuthSession>(verifyResponse);
  setAuthenticatedWorkspace(session.team?.id || null);
  return session;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
  setAuthenticatedWorkspace(null);
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
  const teamWorkspace = window.localStorage.getItem(TEAM_WORKSPACE_KEY);
  if (teamWorkspace) {
    return teamWorkspace;
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

function setAuthenticatedWorkspace(teamId: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  if (teamId) {
    window.localStorage.setItem(TEAM_WORKSPACE_KEY, teamId);
  } else {
    window.localStorage.removeItem(TEAM_WORKSPACE_KEY);
  }
}

function shouldUseDirectBlobUpload(): boolean {
  return API_BASE.startsWith("/api") || API_BASE.includes("stimli.vercel.app");
}

function blobPath(filename: string): string {
  return `workspaces/${getWorkspaceId()}/uploads/${Date.now()}-${safeUploadName(filename)}`;
}

function safeUploadName(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() || "upload.bin";
  return basename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload.bin";
}

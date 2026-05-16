import type {
  Asset,
  AssetType,
  AdminSummary,
  AuditEvent,
  AuthSession,
  BillingStatus,
  BrandProfile,
  BrainProviderHealth,
  BenchmarkRun,
  ChallengerResponse,
  Comparison,
  CreativeBrief,
  GovernancePolicy,
  GovernanceRequest,
  ImportJob,
  LibraryResponse,
  LearningSummary,
  Outcome,
  OutcomeCreate,
  Plan,
  Project,
  Report,
  ShareLink,
  TeamInvite,
  TeamMember,
  TeamRole,
  ValidationCalibration,
  WorkspaceExport,
  WorkspaceOutcome
} from "./types";

// Use logical OR (not ??) so an empty-string env var falls back to the
// default. GitHub Actions substitutes ${{ secrets.X }} as "" when the secret
// is unset, and ?? wouldn't catch that — leading to URLs like /library/assets
// instead of /api/library/assets, which Cloudflare Pages then serves the SPA
// for, breaking JSON parsing in the secondary workbench tabs.
const API_BASE = import.meta.env.VITE_API_BASE || "/api";
const WORKSPACE_KEY = "stimli.workspace";
const TEAM_WORKSPACE_KEY = "stimli.team_workspace";

// Minimal shape of Clerk's window-attached singleton. We only read .session
// from it. The full type lives in @clerk/clerk-js, which we don't import here
// (the React SDK pulls it in at runtime).
type ClerkLike = { session?: { getToken: () => Promise<string | null> } | null };

async function getClerkToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const clerk = (window as unknown as { Clerk?: ClerkLike }).Clerk;
  if (!clerk?.session) return null;
  try {
    return await clerk.session.getToken();
  } catch {
    return null;
  }
}

async function workspaceHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = { "X-Stimli-Workspace": getWorkspaceId() };
  const token = await getClerkToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function jsonHeaders(): Promise<HeadersInit> {
  const base = (await workspaceHeaders()) as Record<string, string>;
  return { ...base, "Content-Type": "application/json" };
}

export async function seedDemo(projectId?: string | null): Promise<Asset[]> {
  const response = await fetch(`${API_BASE}/demo/seed`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify({ project_id: projectId || null })
  });
  return parseResponse(response);
}

export async function listProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE}/projects`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function createProject(input: { name: string; description?: string }): Promise<Project> {
  const response = await fetch(`${API_BASE}/projects`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function listAssets(): Promise<Asset[]> {
  const response = await fetch(`${API_BASE}/assets`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function deleteAsset(assetId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/assets/${encodeURIComponent(assetId)}`, {
    method: "DELETE",
    headers: await workspaceHeaders()
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(extractErrorMessage(message) || `Request failed with ${response.status}`);
  }
}

export async function createTextAsset(input: {
  assetType: AssetType;
  name: string;
  text: string;
  url?: string;
  durationSeconds?: number;
  file?: File | null;
  projectId?: string | null;
  onUploadProgress?: (percentage: number) => void;
}): Promise<Asset> {
  const form = new FormData();
  form.append("asset_type", input.assetType);
  form.append("name", input.name);
  if (input.text) form.append("text", input.text);
  if (input.url) form.append("url", input.url);
  if (input.durationSeconds) form.append("duration_seconds", String(input.durationSeconds));
  if (input.projectId) form.append("project_id", input.projectId);
  if (input.file) form.append("file", input.file);
  const response = await fetch(`${API_BASE}/assets`, {
    method: "POST",
    headers: await workspaceHeaders(),
    body: form
  });
  input.onUploadProgress?.(100);
  const payload = await parseResponse<{ asset: Asset }>(response);
  return payload.asset;
}

export async function createComparison(assetIds: string[], objective: string): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/comparisons`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify({ asset_ids: assetIds, objective })
  });
  return parseResponse(response);
}

export async function createBriefComparison(assetIds: string[], objective: string, brief: CreativeBrief): Promise<Comparison> {
  return createBriefComparisonForProject(assetIds, objective, brief, null);
}

export async function createBriefComparisonForProject(
  assetIds: string[],
  objective: string,
  brief: CreativeBrief,
  projectId?: string | null,
  brandProfileId?: string | null
): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/comparisons`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify({ asset_ids: assetIds, objective, brief, project_id: projectId || null, brand_profile_id: brandProfileId || null })
  });
  return parseResponse(response);
}

export async function listComparisons(): Promise<Comparison[]> {
  const response = await fetch(`${API_BASE}/comparisons`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function getComparison(comparisonId: string): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/comparisons/${comparisonId}`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function cancelComparison(comparisonId: string): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/comparisons/${comparisonId}/cancel`, {
    method: "POST",
    headers: await workspaceHeaders()
  });
  return parseResponse(response);
}

export async function getReport(comparisonId: string): Promise<Report> {
  const response = await fetch(`${API_BASE}/reports/${comparisonId}`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function getReportMarkdown(comparisonId: string): Promise<string> {
  const response = await fetch(`${API_BASE}/reports/${comparisonId}/markdown`, { headers: await workspaceHeaders() });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(extractErrorMessage(message) || `Request failed with ${response.status}`);
  }
  return response.text();
}

export async function createShareLink(comparisonId: string): Promise<ShareLink> {
  const response = await fetch(`${API_BASE}/reports/${comparisonId}/share`, {
    method: "POST",
    headers: await workspaceHeaders()
  });
  return parseResponse(response);
}

export async function getSharedReport(token: string): Promise<Report> {
  const response = await fetch(`${API_BASE}/share/${encodeURIComponent(token)}`);
  return parseResponse(response);
}

export async function createOutcome(comparisonId: string, outcome: OutcomeCreate): Promise<Outcome> {
  const response = await fetch(`${API_BASE}/comparisons/${comparisonId}/outcomes`, {
    method: "POST",
    headers: await jsonHeaders(),
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
    headers: await jsonHeaders(),
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function getLearningSummary(): Promise<LearningSummary> {
  const response = await fetch(`${API_BASE}/learning/summary`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function listWorkspaceOutcomes(): Promise<WorkspaceOutcome[]> {
  const response = await fetch(`${API_BASE}/outcomes`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function getBrainProviders(): Promise<BrainProviderHealth[]> {
  const response = await fetch(`${API_BASE}/brain/providers`);
  return parseResponse(response);
}

export async function getBillingStatus(): Promise<BillingStatus> {
  const response = await fetch(`${API_BASE}/billing/status`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export type UsageSnapshot = {
  plan: Plan;
  billing_configured: boolean;
  commercial_use_enabled: boolean;
  limits: { asset: number; comparison: number };
  usage: { window_ms: number; comparison: number; asset: number };
};

export async function getBillingUsage(): Promise<UsageSnapshot> {
  const response = await fetch(`${API_BASE}/billing/usage`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function startCheckout(plan: string): Promise<{ url: string; id: string }> {
  const response = await fetch(`${API_BASE}/billing/checkout`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify({ plan })
  });
  return parseResponse(response);
}

export async function openBillingPortal(): Promise<{ url: string }> {
  const response = await fetch(`${API_BASE}/billing/portal`, {
    method: "POST",
    headers: await workspaceHeaders()
  });
  return parseResponse(response);
}

export async function getSession(): Promise<AuthSession> {
  const response = await fetch(`${API_BASE}/auth/session`, { headers: await workspaceHeaders() });
  const session = await parseResponse<AuthSession>(response);
  setAuthenticatedWorkspace(session.team?.id || null);
  return session;
}

export async function createTeamInvite(input: { email?: string; role?: TeamRole }): Promise<TeamInvite & { url?: string; token?: string }> {
  const response = await fetch(`${API_BASE}/teams/invites`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function listTeamInvites(): Promise<TeamInvite[]> {
  const response = await fetch(`${API_BASE}/teams/invites`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function revokeTeamInvite(inviteId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/teams/invites/${encodeURIComponent(inviteId)}`, {
    method: "DELETE",
    headers: await workspaceHeaders()
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(extractErrorMessage(message) || `Request failed with ${response.status}`);
  }
}

export async function removeTeamMember(userId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/teams/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: await workspaceHeaders()
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(extractErrorMessage(message) || `Request failed with ${response.status}`);
  }
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  const response = await fetch(`${API_BASE}/teams/members`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function updateTeamMemberRole(userId: string, role: TeamRole): Promise<TeamMember> {
  const response = await fetch(`${API_BASE}/teams/members/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    headers: await jsonHeaders(),
    body: JSON.stringify({ role })
  });
  return parseResponse(response);
}

export async function getAdminSummary(): Promise<AdminSummary> {
  const response = await fetch(`${API_BASE}/admin/summary`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function listAdminJobs(status?: string): Promise<Comparison["jobs"]> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await fetch(`${API_BASE}/admin/jobs${suffix}`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function retryAdminJob(jobId: string): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/admin/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    headers: await workspaceHeaders()
  });
  return parseResponse(response);
}

export async function listAuditEvents(): Promise<AuditEvent[]> {
  const response = await fetch(`${API_BASE}/audit/events`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function listBrandProfiles(): Promise<BrandProfile[]> {
  const response = await fetch(`${API_BASE}/brand-profiles`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function createBrandProfile(input: Partial<BrandProfile> & { name: string; brief: CreativeBrief }): Promise<BrandProfile> {
  const response = await fetch(`${API_BASE}/brand-profiles`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function updateBrandProfile(id: string, input: Partial<BrandProfile>): Promise<BrandProfile> {
  const response = await fetch(`${API_BASE}/brand-profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: await jsonHeaders(),
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function deleteBrandProfile(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/brand-profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await workspaceHeaders()
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(extractErrorMessage(message) || `Request failed with ${response.status}`);
  }
}

export async function exportBrandProfile(id: string): Promise<{ schema: string; exported_at: string; profile: BrandProfile }> {
  const response = await fetch(`${API_BASE}/brand-profiles/${encodeURIComponent(id)}/export`, {
    headers: await workspaceHeaders()
  });
  return parseResponse(response);
}

export async function getGovernancePolicy(): Promise<GovernancePolicy> {
  const response = await fetch(`${API_BASE}/governance/policy`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function exportWorkspace(): Promise<WorkspaceExport> {
  const response = await fetch(`${API_BASE}/governance/export`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function listGovernanceRequests(): Promise<GovernanceRequest[]> {
  const response = await fetch(`${API_BASE}/governance/requests`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function createDeletionRequest(input: {
  target_type: string;
  target_id: string;
  reason: string;
}): Promise<GovernanceRequest> {
  const response = await fetch(`${API_BASE}/governance/deletion-requests`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function listLibraryAssets(): Promise<LibraryResponse> {
  const response = await fetch(`${API_BASE}/library/assets`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function createImportJob(input: {
  platform: string;
  source: string;
  project_id?: string | null;
  items: Array<{ asset_type?: AssetType; name?: string; text?: string; url?: string; duration_seconds?: number }>;
}): Promise<{ job: ImportJob; assets: Asset[] }> {
  const response = await fetch(`${API_BASE}/imports`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function listImportJobs(): Promise<ImportJob[]> {
  const response = await fetch(`${API_BASE}/imports`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function getValidationCalibration(): Promise<ValidationCalibration> {
  const response = await fetch(`${API_BASE}/validation/calibration`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function runValidationBenchmark(benchmarkId = "dtc-hooks-v1"): Promise<BenchmarkRun> {
  const response = await fetch(`${API_BASE}/validation/benchmarks/run`, {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify({ benchmark_id: benchmarkId })
  });
  return parseResponse(response);
}

export async function getInvite(token: string): Promise<TeamInvite> {
  const response = await fetch(`${API_BASE}/invites/${encodeURIComponent(token)}`);
  return parseResponse(response);
}

export async function acceptInvite(token: string): Promise<AuthSession> {
  const response = await fetch(`${API_BASE}/invites/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    headers: await workspaceHeaders()
  });
  const session = await parseResponse<AuthSession>(response);
  setAuthenticatedWorkspace(session.team?.id || null);
  return session;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(extractErrorMessage(raw) || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function extractErrorMessage(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const candidate = pickErrorString(parsed);
      if (candidate) return candidate;
    } catch {
      /* fall through */
    }
  }
  return trimmed;
}

function pickErrorString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickErrorString(item);
      if (found) return found;
    }
    return "";
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["detail", "message", "error", "msg"]) {
      if (key in record) {
        const found = pickErrorString(record[key]);
        if (found) return found;
      }
    }
  }
  return "";
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

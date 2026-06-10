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
let volatileWorkspaceId: string | null = null;
let volatileTeamWorkspaceId: string | null = null;

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
  const token = await getClerkToken();
  const headers: Record<string, string> = { "X-Stimli-Workspace": getWorkspaceId({ allowTeamWorkspace: Boolean(token) }) };
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
  await parseResponse<void>(response);
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
  if (input.durationSeconds !== undefined) form.append("duration_seconds", String(input.durationSeconds));
  if (input.projectId) form.append("project_id", input.projectId);
  if (input.file) form.append("file", input.file);
  const response = await fetch(`${API_BASE}/assets`, {
    method: "POST",
    headers: await workspaceHeaders(),
    body: form
  });
  // Only report 100% after the response is parsed and validated — otherwise a
  // server-side error (auth/quota/rate-limit) still ticks the progress bar to
  // success and the caller's optimistic UI lies about a failed upload.
  const payload = await parseResponse<{ asset: Asset }>(response);
  input.onUploadProgress?.(100);
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
  const response = await fetch(`${API_BASE}/comparisons/${encodeURIComponent(comparisonId)}`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function cancelComparison(comparisonId: string): Promise<Comparison> {
  const response = await fetch(`${API_BASE}/comparisons/${encodeURIComponent(comparisonId)}/cancel`, {
    method: "POST",
    headers: await workspaceHeaders()
  });
  return parseResponse(response);
}

export async function deleteComparison(comparisonId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/comparisons/${encodeURIComponent(comparisonId)}`, {
    method: "DELETE",
    headers: await workspaceHeaders()
  });
  await parseResponse<void>(response);
}

export async function getReport(comparisonId: string): Promise<Report> {
  const response = await fetch(`${API_BASE}/reports/${encodeURIComponent(comparisonId)}`, { headers: await workspaceHeaders() });
  return parseResponse(response);
}

export async function getReportMarkdown(comparisonId: string): Promise<string> {
  const response = await fetch(`${API_BASE}/reports/${encodeURIComponent(comparisonId)}/markdown`, { headers: await workspaceHeaders() });
  return parseTextResponse(response);
}

export async function createShareLink(comparisonId: string): Promise<ShareLink> {
  const response = await fetch(`${API_BASE}/reports/${encodeURIComponent(comparisonId)}/share`, {
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
  const response = await fetch(`${API_BASE}/comparisons/${encodeURIComponent(comparisonId)}/outcomes`, {
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
  const response = await fetch(`${API_BASE}/comparisons/${encodeURIComponent(comparisonId)}/challengers`, {
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

export async function deleteWorkspaceOutcome(outcomeId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/outcomes/${encodeURIComponent(outcomeId)}`, {
    method: "DELETE",
    headers: await workspaceHeaders()
  });
  await parseResponse<void>(response);
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
  subscription: {
    plan: "research" | "growth" | "scale";
    status: string;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    trial_end: string | null;
  } | null;
  billing_configured: boolean;
  commercial_use_enabled: boolean;
  limits: { asset: number; comparison: number };
  monthly_limits: { asset: number; comparison: number };
  period: { start: string; end: string; source: "stripe" | "calendar_month" };
  usage: { window_ms: number; comparison: number; asset: number };
  monthly_usage: { comparison: number; asset: number };
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
  await parseResponse<void>(response);
}

export async function removeTeamMember(userId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/teams/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: await workspaceHeaders()
  });
  await parseResponse<void>(response);
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
  await parseResponse<void>(response);
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

// Structured error thrown on any non-2xx so callers can branch on status and
// code without parsing message strings. Quota responses (HTTP 402, code
// "quota_exceeded") carry a `details` object the upgrade modal reads to fill
// in the plan, limit, used count, and reset_at fields.
export class StimliApiError extends Error {
  status: number;
  code: string | null;
  details: Record<string, unknown> | null;
  requestId: string | null;
  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> | null,
    requestId: string | null = null
  ) {
    super(message);
    this.name = "StimliApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let parsed: unknown = null;
  let parsedJson = false;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
      parsedJson = true;
    } catch {
      /* keep parsed null */
    }
  }
  if (!response.ok) {
    throw structuredApiError(response, raw);
  }
  if (!raw) return null as T;
  if (!parsedJson) {
    throw new StimliApiError("Response was not valid JSON.", response.status, null, null);
  }
  return parsed as T;
}

async function parseTextResponse(response: Response): Promise<string> {
  const raw = await response.text();
  if (!response.ok) {
    throw structuredApiError(response, raw);
  }
  return raw;
}

function structuredApiError(response: Response, raw: string): StimliApiError {
  let parsed: unknown = null;
  let parsedJson = false;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
      parsedJson = true;
    } catch {
      /* keep parsed null */
    }
  }
  const baseMessage = extractErrorMessage(raw) || `Request failed with ${response.status}`;
  const code =
    parsedJson && parsed && typeof parsed === "object" && "code" in parsed && typeof (parsed as { code: unknown }).code === "string"
      ? ((parsed as { code: string }).code)
      : null;
  const details =
    parsedJson && parsed && typeof parsed === "object" && "details" in parsed && typeof (parsed as { details: unknown }).details === "object"
      ? ((parsed as { details: Record<string, unknown> }).details)
      : null;
  // The server stamps opaque 5xx bodies (and the X-Request-Id header) with a
  // correlation id that maps to its logged stack trace. Append it to the message
  // so the toast a user screenshots in a bug report is actually greppable.
  const requestId =
    (parsedJson && parsed && typeof parsed === "object" && "request_id" in parsed && typeof (parsed as { request_id: unknown }).request_id === "string"
      ? ((parsed as { request_id: string }).request_id)
      : null) || response.headers.get("x-request-id");
  const message =
    response.status >= 500 && requestId ? `${baseMessage} (ref: ${requestId})` : baseMessage;
  // Quota responses get a global event so the shell can swap to the Billing
  // view without each call site having to remember to handle the case.
  if (response.status === 402 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("stimli:upgrade-required", { detail: { code, details } }));
  }
  return new StimliApiError(message, response.status, code, details, requestId);
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

function getWorkspaceId({ allowTeamWorkspace = true }: { allowTeamWorkspace?: boolean } = {}): string {
  if (typeof window === "undefined") {
    return "public";
  }
  const teamWorkspace = allowTeamWorkspace ? readLocalStorage(TEAM_WORKSPACE_KEY) || volatileTeamWorkspaceId : null;
  if (teamWorkspace) {
    return teamWorkspace;
  }
  const existing = readLocalStorage(WORKSPACE_KEY) || volatileWorkspaceId;
  if (existing) {
    return existing;
  }
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "") ?? `${Date.now()}${Math.random()}`.replace(/\D/g, "");
  const workspaceId = `ws_${random.slice(0, 32)}`;
  volatileWorkspaceId = workspaceId;
  writeLocalStorage(WORKSPACE_KEY, workspaceId);
  return workspaceId;
}

function setAuthenticatedWorkspace(teamId: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  volatileTeamWorkspaceId = teamId;
  if (teamId) {
    writeLocalStorage(TEAM_WORKSPACE_KEY, teamId);
  } else {
    removeLocalStorage(TEAM_WORKSPACE_KEY);
  }
}

// Switch the active team workspace. Subsequent requests send this team id as
// X-Stimli-Workspace, which the API resolves to the active team when the signed-
// in user is a verified member. Callers should refetch session-scoped data so
// every view remounts under the new workspace.
export function setActiveTeam(teamId: string | null) {
  setAuthenticatedWorkspace(teamId);
}

export function activeTeamId(): string | null {
  if (typeof window === "undefined") return null;
  return readLocalStorage(TEAM_WORKSPACE_KEY) || volatileTeamWorkspaceId;
}

function readLocalStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* keep the in-memory fallback */
  }
}

function removeLocalStorage(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* keep the in-memory fallback */
  }
}

// Cloudflare Pages Functions port of api/_lib/billing.js.
//
// Differences from the Vercel version:
// - Stripe is imported lazily (dynamic import) and uses Stripe.createFetchHttpClient()
//   so it works in the Workers runtime when the Stripe Node SDK's default HTTP
//   client isn't available.
// - configureBilling(env) is the entry point for env access instead of process.env.
// - Billing is fully optional. With Stripe env vars unset, billingStatus reports
//   not-configured, usageLimitsForWorkspace returns plan defaults, and any
//   commerce endpoint throws 503.

import { getTeam, saveTeam } from "./store.js";

let _env = {};

export function configureBilling(env) {
  _env = env || {};
}

function getEnv(name) {
  return _env[name];
}

function getCatalog() {
  return [
    {
      id: "research",
      name: "Research",
      asset_limit_per_hour: Number(getEnv("STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR") || 40),
      comparison_limit_per_hour: Number(getEnv("STIMLI_RESEARCH_COMPARISON_LIMIT_PER_HOUR") || 12),
      commercial: false,
      price_env: null
    },
    {
      id: "growth",
      name: "Growth",
      asset_limit_per_hour: Number(getEnv("STIMLI_GROWTH_ASSET_LIMIT_PER_HOUR") || 300),
      comparison_limit_per_hour: Number(getEnv("STIMLI_GROWTH_COMPARISON_LIMIT_PER_HOUR") || 100),
      commercial: true,
      price_env: "STRIPE_GROWTH_PRICE_ID"
    },
    {
      id: "scale",
      name: "Scale",
      asset_limit_per_hour: Number(getEnv("STIMLI_SCALE_ASSET_LIMIT_PER_HOUR") || 2000),
      comparison_limit_per_hour: Number(getEnv("STIMLI_SCALE_COMPARISON_LIMIT_PER_HOUR") || 500),
      commercial: true,
      price_env: "STRIPE_SCALE_PRICE_ID"
    }
  ];
}

export async function billingStatus(team = null) {
  const catalog = getCatalog();
  const currentPlanId = normalizePlan(team?.plan, catalog);
  const currentPlan = planById(currentPlanId, catalog);
  return {
    current_plan: currentPlan,
    billing_configured: billingConfigured(),
    commercial_use_enabled: commercialUseEnabled(),
    license: licenseStatus(),
    plans: catalog.map((plan) => ({
      ...plan,
      configured: plan.id === "research" || Boolean(plan.price_env && getEnv(plan.price_env))
    }))
  };
}

export async function usageLimitsForWorkspace(workspaceId) {
  const catalog = getCatalog();
  const team = workspaceId && workspaceId !== "public" ? await getTeam(workspaceId) : null;
  const plan = planById(normalizePlan(team?.plan, catalog), catalog);
  return {
    asset: envLimit("STIMLI_ASSET_LIMIT_PER_HOUR") ?? plan.asset_limit_per_hour,
    comparison: envLimit("STIMLI_COMPARISON_LIMIT_PER_HOUR") ?? plan.comparison_limit_per_hour
  };
}

export async function createCheckoutSession(request, team, requestedPlan) {
  if (!team) {
    throw httpError(401, "Sign in before upgrading.");
  }
  if (!billingConfigured()) {
    throw httpError(503, "Billing is not configured.");
  }
  const catalog = getCatalog();
  const plan = planById(requestedPlan, catalog);
  if (!plan.commercial || !plan.price_env || !getEnv(plan.price_env)) {
    throw httpError(400, "Plan is not available for checkout.");
  }
  if (!commercialUseEnabled()) {
    throw httpError(409, "Commercial plans require a licensed commercial brain-response provider.");
  }

  const stripe = await stripeClient();
  let customerId = team.stripe_customer_id || "";
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: team.name,
      metadata: { team_id: team.id }
    });
    customerId = customer.id;
    await saveTeam({ ...team, stripe_customer_id: customerId });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: getEnv(plan.price_env), quantity: 1 }],
    success_url: `${appOrigin(request)}/?billing=success`,
    cancel_url: `${appOrigin(request)}/?billing=cancelled`,
    client_reference_id: team.id,
    metadata: { team_id: team.id, plan: plan.id },
    subscription_data: {
      metadata: { team_id: team.id, plan: plan.id }
    }
  });
  return { url: session.url, id: session.id };
}

export async function createPortalSession(request, team) {
  if (!team) {
    throw httpError(401, "Sign in before opening billing.");
  }
  if (!billingConfigured()) {
    throw httpError(503, "Billing is not configured.");
  }
  if (!team.stripe_customer_id) {
    throw httpError(404, "No billing customer exists for this team.");
  }
  const stripe = await stripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: team.stripe_customer_id,
    return_url: appOrigin(request)
  });
  return { url: session.url };
}

export async function handleBillingWebhook(signature, rawBody) {
  if (!getEnv("STRIPE_WEBHOOK_SECRET")) {
    throw httpError(503, "Billing webhook is not configured.");
  }
  const catalog = getCatalog();
  const stripe = await stripeClient();
  const event = await stripe.webhooks.constructEventAsync(rawBody, signature, getEnv("STRIPE_WEBHOOK_SECRET"));
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    await updateTeamPlan(session.metadata?.team_id, {
      plan: normalizePlan(session.metadata?.plan, catalog),
      stripe_customer_id: stringValue(session.customer),
      stripe_subscription_id: stringValue(session.subscription),
      billing_status: "active"
    });
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
    const subscription = event.data.object;
    await updateTeamPlan(subscription.metadata?.team_id, {
      plan: normalizePlan(subscription.metadata?.plan, catalog),
      stripe_subscription_id: subscription.id,
      billing_status: subscription.status
    });
  }
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    await updateTeamPlan(subscription.metadata?.team_id, {
      plan: "research",
      stripe_subscription_id: subscription.id,
      billing_status: "cancelled"
    });
  }
  return { received: true };
}

function billingConfigured() {
  return Boolean(getEnv("STRIPE_SECRET_KEY") && getEnv("STIMLI_APP_URL"));
}

function commercialUseEnabled() {
  const provider = String(getEnv("STIMLI_BRAIN_PROVIDER") || "fixture").toLowerCase();
  const usesTribe = provider.includes("tribe");
  return !usesTribe || getEnv("STIMLI_TRIBE_COMMERCIAL_LICENSE") === "1";
}

function licenseStatus() {
  return {
    provider: getEnv("STIMLI_BRAIN_PROVIDER") || "fixture",
    tribe_commercial_license: getEnv("STIMLI_TRIBE_COMMERCIAL_LICENSE") === "1",
    mode: commercialUseEnabled() ? "commercial-ready" : "research-only"
  };
}

function planById(planId, catalog) {
  return catalog.find((plan) => plan.id === normalizePlan(planId, catalog)) || catalog[0];
}

function envLimit(name) {
  const value = Number(getEnv(name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizePlan(planId, catalog) {
  return catalog.some((plan) => plan.id === planId) ? planId : "research";
}

async function updateTeamPlan(teamId, patch) {
  if (!teamId) {
    return;
  }
  const team = await getTeam(teamId);
  if (!team) {
    return;
  }
  await saveTeam({ ...team, ...patch, updated_at: new Date().toISOString() });
}

async function stripeClient() {
  // Lazy-import so the bundle doesn't pull in Stripe when billing is disabled.
  const { default: Stripe } = await import("stripe");
  return new Stripe(getEnv("STRIPE_SECRET_KEY"), {
    httpClient: Stripe.createFetchHttpClient()
  });
}

function appOrigin(request) {
  const configured = getEnv("STIMLI_APP_URL");
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  const host = header(request, "x-forwarded-host") || header(request, "host") || "stimli.pages.dev";
  const protocol = header(request, "x-forwarded-proto") || (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host.split(",")[0].trim()}`;
}

function header(request, name) {
  if (request?.headers?.get && typeof request.headers.get === "function") {
    return request.headers.get(name) || "";
  }
  const headers = request?.headers || {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return "";
}

function stringValue(value) {
  return value && typeof value === "object" ? value.id : String(value || "");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// Stripe billing + plan/quota model for the Stimli API.
//
// Stripe is imported lazily (dynamic import) and uses Stripe.createFetchHttpClient()
// so it works in the Workers runtime. With STRIPE_SECRET_KEY unset (the default),
// billingStatus reports not-configured, quota lookups return the free-tier
// defaults, and every commerce endpoint throws 503. configureBilling(env) is
// called once per request from the Pages Function entry point.
//
// What this module owns:
//   - The plan catalog: id, name, prices, monthly and hourly quotas, features.
//     Hourly limits stay as bot/abuse protection; monthly limits are the real
//     SaaS quota a paying customer hits.
//   - Resolving a workspace's current plan, current period bounds, and limits.
//   - Stripe Checkout, Stripe Customer Portal, and Stripe Webhooks (idempotent).
//
// The actual usage counts live in stimli_usage_events; quota enforcement
// (counting + 402/429 responses) lives in functions/api/[[path]].js so it can
// stay close to the route handlers that emit usage events.

import {
  getSubscription,
  getSubscriptionByCustomerId,
  getSubscriptionByStripeId,
  getTeam,
  recordBillingEvent,
  saveSubscription,
  saveTeam
} from "./store.js";

let _env = {};

export function configureBilling(env) {
  _env = env || {};
}

function getEnv(name) {
  return _env[name];
}

function envNum(name, fallback) {
  const value = Number(getEnv(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// The catalog is the single source of truth for what a plan offers. The
// frontend renders the pricing page from /billing/status, the backend enforces
// quotas from getQuotaForPlan(), and the webhook handler derives plan ids by
// matching Stripe price ids against price_env entries. Free-tier numbers stay
// generous enough for a research demo but small enough that the upgrade story
// is obvious for an actual DTC team running daily comparisons.
function getCatalog() {
  return [
    {
      id: "research",
      name: "Research",
      tagline: "Free for solo research and CS 153 demos.",
      price_cents_monthly: 0,
      seats: envNum("STIMLI_RESEARCH_SEATS", 3),
      asset_limit_per_hour: envNum("STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR", 40),
      comparison_limit_per_hour: envNum("STIMLI_RESEARCH_COMPARISON_LIMIT_PER_HOUR", 12),
      asset_limit_per_month: envNum("STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH", 200),
      comparison_limit_per_month: envNum("STIMLI_RESEARCH_COMPARISON_LIMIT_PER_MONTH", 25),
      retention_days: envNum("STIMLI_RESEARCH_RETENTION_DAYS", 30),
      features: [
        "Side-by-side variant comparisons",
        "Public share links (14-day TTL)",
        "Deterministic brain-response provider",
        "Email + passkey sign-in"
      ],
      commercial: false,
      price_env: null
    },
    {
      id: "growth",
      name: "Growth",
      tagline: "For DTC teams shipping creative every week.",
      price_cents_monthly: envNum("STIMLI_GROWTH_PRICE_CENTS_MONTHLY", 14900),
      seats: envNum("STIMLI_GROWTH_SEATS", 5),
      asset_limit_per_hour: envNum("STIMLI_GROWTH_ASSET_LIMIT_PER_HOUR", 300),
      comparison_limit_per_hour: envNum("STIMLI_GROWTH_COMPARISON_LIMIT_PER_HOUR", 100),
      asset_limit_per_month: envNum("STIMLI_GROWTH_ASSET_LIMIT_PER_MONTH", 4000),
      comparison_limit_per_month: envNum("STIMLI_GROWTH_COMPARISON_LIMIT_PER_MONTH", 500),
      retention_days: envNum("STIMLI_GROWTH_RETENTION_DAYS", 365),
      features: [
        "Everything in Research",
        "5 seats + role-based access",
        "Brand profiles + creative library",
        "Outcome tracking and calibration",
        "Hosted TRIBE inference (when enabled)"
      ],
      commercial: true,
      price_env: "STRIPE_GROWTH_PRICE_ID"
    },
    {
      id: "scale",
      name: "Scale",
      tagline: "For platforms and agencies with enterprise governance.",
      price_cents_monthly: envNum("STIMLI_SCALE_PRICE_CENTS_MONTHLY", 49900),
      seats: envNum("STIMLI_SCALE_SEATS", 25),
      asset_limit_per_hour: envNum("STIMLI_SCALE_ASSET_LIMIT_PER_HOUR", 2000),
      comparison_limit_per_hour: envNum("STIMLI_SCALE_COMPARISON_LIMIT_PER_HOUR", 500),
      asset_limit_per_month: envNum("STIMLI_SCALE_ASSET_LIMIT_PER_MONTH", 40000),
      comparison_limit_per_month: envNum("STIMLI_SCALE_COMPARISON_LIMIT_PER_MONTH", 5000),
      retention_days: envNum("STIMLI_SCALE_RETENTION_DAYS", 1095),
      features: [
        "Everything in Growth",
        "25 seats + audit log retention",
        "Bulk import and workspace export",
        "Validation benchmarks + governance review",
        "SAML/SSO via Clerk (when enabled)",
        "Priority support"
      ],
      commercial: true,
      price_env: "STRIPE_SCALE_PRICE_ID"
    }
  ];
}

function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    price_cents_monthly: plan.price_cents_monthly,
    seats: plan.seats,
    asset_limit_per_hour: plan.asset_limit_per_hour,
    comparison_limit_per_hour: plan.comparison_limit_per_hour,
    asset_limit_per_month: plan.asset_limit_per_month,
    comparison_limit_per_month: plan.comparison_limit_per_month,
    retention_days: plan.retention_days,
    features: plan.features,
    commercial: plan.commercial,
    configured: plan.id === "research" || Boolean(plan.price_env && getEnv(plan.price_env))
  };
}

export async function billingStatus(team = null) {
  const catalog = getCatalog();
  const subscription = team ? await getSubscription(team.id) : null;
  const currentPlanId = normalizePlan(subscription?.plan || team?.plan, catalog);
  const currentPlan = catalog.find((plan) => plan.id === currentPlanId) || catalog[0];
  return {
    current_plan: publicPlan(currentPlan),
    subscription: publicSubscription(subscription),
    billing_configured: billingConfigured(),
    commercial_use_enabled: commercialUseEnabled(),
    license: licenseStatus(),
    plans: catalog.map(publicPlan)
  };
}

// Quota lookup used by route handlers when enforcing limits or rendering the
// usage meter. Returns both hourly (abuse guard) and monthly (real SaaS quota)
// numbers, plus the current billing cycle's start so we can sum usage events
// for the right window. When no Stripe subscription exists yet, the period
// falls back to the UTC calendar month — same behavior as a fresh free tenant.
export async function getQuotaForWorkspace(workspaceId) {
  const catalog = getCatalog();
  const team = workspaceId && workspaceId !== "public" ? await getTeam(workspaceId) : null;
  const subscription = team ? await getSubscription(team.id) : null;
  const planId = normalizePlan(subscription?.plan || team?.plan, catalog);
  const plan = catalog.find((p) => p.id === planId) || catalog[0];

  // Env-level overrides are still honored as a kill switch for tightening or
  // loosening limits in an incident without redeploying. They only apply to
  // hourly limits — monthly quotas come straight from the plan.
  const hourlyAssetOverride = envNum("STIMLI_ASSET_LIMIT_PER_HOUR", null);
  const hourlyComparisonOverride = envNum("STIMLI_COMPARISON_LIMIT_PER_HOUR", null);

  const period = currentPeriod(subscription);

  return {
    plan: publicPlan(plan),
    hourly: {
      asset: hourlyAssetOverride ?? plan.asset_limit_per_hour,
      comparison: hourlyComparisonOverride ?? plan.comparison_limit_per_hour
    },
    monthly: {
      asset: plan.asset_limit_per_month,
      comparison: plan.comparison_limit_per_month
    },
    period
  };
}

// Back-compat shim so older call sites still get the hourly-only shape.
export async function usageLimitsForWorkspace(workspaceId) {
  const quota = await getQuotaForWorkspace(workspaceId);
  return {
    asset: quota.hourly.asset,
    comparison: quota.hourly.comparison
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
  const plan = catalog.find((p) => p.id === requestedPlan);
  if (!plan) {
    throw httpError(400, "Unknown plan.");
  }
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
    await saveTeam({ ...team, stripe_customer_id: customerId, updated_at: nowIso() });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: getEnv(plan.price_env), quantity: 1 }],
    success_url: `${appOrigin(request)}/?billing=success`,
    cancel_url: `${appOrigin(request)}/?billing=cancelled`,
    client_reference_id: team.id,
    allow_promotion_codes: true,
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
  const stripe = await stripeClient();
  const event = await stripe.webhooks.constructEventAsync(
    rawBody,
    signature,
    getEnv("STRIPE_WEBHOOK_SECRET")
  );

  // Idempotency: Stripe retries deliveries; recordBillingEvent returns false
  // if the event id already exists, so a replay short-circuits before we
  // mutate any subscription state.
  const fresh = await recordBillingEvent({
    id: event.id,
    type: event.type,
    team_id: extractTeamId(event) || "",
    payload: { type: event.type, livemode: event.livemode, created: event.created },
    created_at: nowIso()
  });
  if (!fresh) {
    return { received: true, duplicate: true };
  }

  switch (event.type) {
    case "checkout.session.completed":
      await onCheckoutCompleted(event.data.object, stripe);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await onSubscriptionChanged(event.data.object);
      break;
    case "customer.subscription.deleted":
      await onSubscriptionDeleted(event.data.object);
      break;
    case "invoice.payment_succeeded":
      await onInvoicePaid(event.data.object);
      break;
    case "invoice.payment_failed":
      await onInvoiceFailed(event.data.object);
      break;
    case "customer.subscription.trial_will_end":
      await onTrialWillEnd(event.data.object);
      break;
    default:
      // Unhandled events are still recorded so we have a trail; nothing else
      // to do — Stripe expects a 2xx to stop retrying.
      break;
  }
  return { received: true };
}

async function onCheckoutCompleted(session, stripe) {
  const teamId = session.metadata?.team_id || session.client_reference_id;
  if (!teamId) return;
  const team = await getTeam(teamId);
  if (!team) return;
  // Persist the customer id on the team as soon as checkout completes; even
  // if subscription.created lands first (it usually does), this is the
  // canonical place to wire the team to its Stripe customer.
  const customerId = stringValue(session.customer);
  if (customerId && customerId !== team.stripe_customer_id) {
    await saveTeam({ ...team, stripe_customer_id: customerId, updated_at: nowIso() });
  }
  // Pull the subscription so we get current_period_end / status straight from
  // the source of truth instead of waiting for the next subscription.* event.
  const subscriptionId = stringValue(session.subscription);
  if (subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    await onSubscriptionChanged(sub);
  }
}

async function onSubscriptionChanged(subscription) {
  const teamId =
    subscription.metadata?.team_id ||
    (await teamIdForCustomer(stringValue(subscription.customer))) ||
    (await getSubscriptionByStripeId(subscription.id))?.team_id;
  if (!teamId) return;

  const planId = planIdForSubscription(subscription);
  const record = {
    team_id: teamId,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: stringValue(subscription.customer),
    plan: planId,
    status: subscription.status,
    current_period_start: subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000).toISOString()
      : null,
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    trial_end: subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  await saveSubscription(record);
  await syncTeamPlan(teamId, planId, subscription.status);
}

async function onSubscriptionDeleted(subscription) {
  const teamId =
    subscription.metadata?.team_id ||
    (await getSubscriptionByStripeId(subscription.id))?.team_id;
  if (!teamId) return;
  const record = {
    team_id: teamId,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: stringValue(subscription.customer),
    plan: "research",
    status: "cancelled",
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    trial_end: null,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  await saveSubscription(record);
  await syncTeamPlan(teamId, "research", "cancelled");
}

async function onInvoicePaid(invoice) {
  const teamId = await teamIdForCustomer(stringValue(invoice.customer));
  if (!teamId) return;
  const existing = await getSubscription(teamId);
  if (!existing) return;
  await saveSubscription({
    ...existing,
    status: "active",
    last_invoice_paid_at: nowIso(),
    last_invoice_amount_paid: invoice.amount_paid || 0,
    updated_at: nowIso()
  });
}

async function onInvoiceFailed(invoice) {
  const teamId = await teamIdForCustomer(stringValue(invoice.customer));
  if (!teamId) return;
  const existing = await getSubscription(teamId);
  if (!existing) return;
  await saveSubscription({
    ...existing,
    status: "past_due",
    last_invoice_failed_at: nowIso(),
    updated_at: nowIso()
  });
}

async function onTrialWillEnd(subscription) {
  const teamId =
    subscription.metadata?.team_id ||
    (await getSubscriptionByStripeId(subscription.id))?.team_id;
  if (!teamId) return;
  const existing = await getSubscription(teamId);
  if (!existing) return;
  await saveSubscription({
    ...existing,
    trial_will_end_notified_at: nowIso(),
    updated_at: nowIso()
  });
}

async function syncTeamPlan(teamId, planId, billingStatusValue) {
  const team = await getTeam(teamId);
  if (!team) return;
  await saveTeam({
    ...team,
    plan: planId,
    billing_status: billingStatusValue,
    updated_at: nowIso()
  });
}

function extractTeamId(event) {
  const obj = event.data?.object || {};
  return (
    obj.metadata?.team_id ||
    obj.client_reference_id ||
    obj.subscription_details?.metadata?.team_id ||
    ""
  );
}

function planIdForSubscription(subscription) {
  // Prefer metadata when present (set when we created the checkout session).
  // Fall back to matching the line item's price id against env-configured
  // STRIPE_*_PRICE_ID values so a Stripe Dashboard-side plan swap still works.
  const fromMetadata = subscription.metadata?.plan;
  if (fromMetadata) return fromMetadata;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (!priceId) return "research";
  if (getEnv("STRIPE_GROWTH_PRICE_ID") === priceId) return "growth";
  if (getEnv("STRIPE_SCALE_PRICE_ID") === priceId) return "scale";
  return "research";
}

async function teamIdForCustomer(customerId) {
  if (!customerId) return "";
  // Reverse-lookup via the dedicated index on stimli_subscriptions.
  // Used when a webhook event arrives without team metadata (e.g. an
  // invoice.payment_failed triggered by a manual Stripe Dashboard charge).
  const sub = await getSubscriptionByCustomerId(customerId);
  return sub?.team_id || "";
}

function currentPeriod(subscription) {
  if (subscription?.current_period_start && subscription?.current_period_end) {
    return {
      start: subscription.current_period_start,
      end: subscription.current_period_end,
      source: "stripe"
    };
  }
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    source: "calendar_month"
  };
}

function publicSubscription(subscription) {
  if (!subscription) return null;
  return {
    plan: subscription.plan,
    status: subscription.status,
    current_period_start: subscription.current_period_start || null,
    current_period_end: subscription.current_period_end || null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    trial_end: subscription.trial_end || null
  };
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

function normalizePlan(planId, catalog) {
  return catalog.some((plan) => plan.id === planId) ? planId : "research";
}

async function stripeClient() {
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

function nowIso() {
  return new Date().toISOString();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

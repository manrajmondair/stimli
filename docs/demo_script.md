# Demo Script

## 0:00-0:25 Problem

Growth teams ship too many ads by gut feel. They can see results after spending money, but the expensive question happens before launch: which creative deserves budget, and what should be fixed first?

## 0:25-1:15 Product Walkthrough

Open Stimli and load the demo assets. The left side captures the creative variants and campaign brief: brand, audience, category, offer, required claims, and terms to avoid.

Select two or more variants and run the comparison. Stimli produces a direct decision, confidence score, ranked variants, score breakdowns, predicted response timeline, and edit cards.

## 1:15-2:10 Architecture

The production product is a single Vercel app: a React/Vite interface with same-origin serverless API routes, Postgres persistence, private Blob uploads, passkey accounts, team workspaces, projects, share links, and billing/license guardrails. A separate FastAPI service remains available for local research-model experimentation.

The analysis combines hosted TRIBE-compatible response curves when configured with creative heuristics: hook, clarity, CTA, brand cue, pacing, offer strength, audience fit, attention, memory, and cognitive load. Modal handles GPU inference and extraction outside the Vercel request path.

## 2:10-2:45 Product Loop

After the recommendation, Stimli can draft a focused challenger variant. After launch, the user logs spend, impressions, clicks, conversions, and revenue. That creates the foundation for future calibration between pre-spend predictions and real performance.

## 2:45-3:00 Impact

The goal is to help small teams make better creative decisions before wasting budget, giving one person the leverage of a creative strategist, testing analyst, and research team.

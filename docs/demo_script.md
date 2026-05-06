# Demo Script

## 0:00-0:25 Problem

Growth teams ship too many ads by gut feel. They can see results after spending money, but the expensive question happens before launch: which creative deserves budget, and what should be fixed first?

## 0:25-1:15 Product Walkthrough

Open Stimli and load the demo assets. The left side captures the creative variants and campaign brief: brand, audience, category, offer, required claims, and terms to avoid.

Select two or more variants and run the comparison. Stimli produces a direct decision, confidence score, ranked variants, score breakdowns, predicted response timeline, and edit cards.

## 1:15-2:10 Architecture

The backend is a FastAPI service with SQLite persistence, file storage, URL extraction, deterministic response fixtures, and an isolated provider interface for research brain-response models. The frontend is a React decision dashboard optimized around A/B comparison rather than generic analytics.

The analysis combines predicted response curves with creative heuristics: hook, clarity, CTA, brand cue, pacing, offer strength, audience fit, attention, memory, and cognitive load.

## 2:10-2:45 Product Loop

After the recommendation, Stimli can draft a focused challenger variant. After launch, the user logs spend, impressions, clicks, conversions, and revenue. That creates the foundation for future calibration between pre-spend predictions and real performance.

## 2:45-3:00 Impact

The goal is to help small teams make better creative decisions before wasting budget, giving one person the leverage of a creative strategist, testing analyst, and research team.


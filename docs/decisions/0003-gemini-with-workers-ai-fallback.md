# 0003: Gemini Flash first, Workers AI as the fallback

Date: 2026-10-18 · Status: accepted

**Context.** The demos need structured answers (a lead score, invoice fields). Free tiers have rate limits that
change often.

**Decision.** Gemini Flash (`gemini-3.8-flash`, set in `GEMINI_MODEL`) with `responseJsonSchema`, validated with
zod. One retry with the validation error, then Workers AI (`WORKERS_AI_MODEL`) with the same schema. Files (PDFs,
images) go only to Gemini, because the fallback model reads text only.

**Consequences.** A Gemini outage or rate limit degrades to a smaller model instead of a failed run. Every run
records which model answered. Only synthetic data goes to the free tier, because free-tier content may be used to
improve Google's products.

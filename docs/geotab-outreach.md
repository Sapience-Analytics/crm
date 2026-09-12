# Geotab prospecting

Open **Agents → Geotab prospecting**. The route is `/sapience-analytics/agents/geotab`.

The campaign starts paused. Creating the campaign does not send email or call research providers.

## Workflow

The agent's existing minute schedule checks research jobs and reply drafts. Research runs at most hourly.
The Perplexity Agent API finds up to five prospects per request. The weekly target is 50 new WA companies.
The worker verifies source quotations, WA location text and published email addresses against the company's website.
Unverified records stay on hold. Vehicle counts stay unknown during discovery. Plant and employee counts never become vehicle counts.

Verified companies enter CompAI without overwriting existing fields. Existing Context enrichment fills company details.
Recent unanswered CRM emails explicitly requesting Geotab or fleet-tracking contact establish automatic eligibility.
Other prospects require documented consent or an assessed inferred-consent basis. Publication alone never enables sending.
The first two eligible prospects remain manual permanently. The next ten form the automated pilot.

The API's protected five-minute cron handles Gmail. It sends at most one queued message per tick.
Daily limits are 10 initial messages and 30 total messages, weekdays from 10 am to 3 pm Perth time.
Follow-ups fall 4 and 10 weekdays after the initial send. Public holidays are not excluded.
No third follow-up exists. An overdue message waits for the next sending window and available daily capacity.

Templates use the company name and an exact verified source quote. AI research chooses the relevant fact.
Replies pause the sequence. AI creates a proposed reply in CompAI. Danny reviews and sends it himself.
The worker never sends AI reply drafts. The ordinary Gmail inbox also receives the original reply.
Weekly reports appear on the campaign page. They do not send a separate report email.

## Launch

1. Deploy API first. Its production build applies the additive migration. Then deploy agent and app.
2. Create the paused campaign as `danny@sapienceanalytics.com.au`.
3. Configure the existing `PERPLEXITY_API_KEY` on the agent's Production environment. Never paste the key into chat.
4. Enable cloud research. Review source and eligibility holds in the campaign page.
5. Connect Gmail sending from the campaign page. Existing read permissions remain required; sending is an additional grant.
6. Review the actual templates and rules. Approve their current version once.
7. Record SPF, DKIM, DMARC and controlled delivery, reply-stop, opt-out-stop and CRM logging checks.
8. Start the pilot after all twelve eligible prospects have their permanent allocations.
9. Accept the pilot and activate weekly sending after all ten initial deliveries are confirmed and logged.

Research and sending have separate pause controls. Template edits pause sending and revoke approval and launch checks.
Preview deployments and local processes do not run outreach workers. `VERCEL_ENV=production` is required.
Missing research credentials appear as a held research status. They never enable an unmetered fallback.

## Safety and recovery

Company domains and recipient emails are unique across the campaign. Each prospect has one delivery per sequence stage.
Campaign leases prevent overlapping send workers. Database transactions enforce limits and permanent manual exclusions.
Before sending, the worker checks suppression, a recent Calendar sync, bookings, Gmail search and the actual Gmail thread.
Unreadable, incomplete or stale mailbox evidence holds sending. CRM import filters cannot hide replies from the direct Gmail check.
Manual outbound contact also stops the sequence. Quoted email history is removed before opt-out classification.

Every send reserves a durable delivery with a fixed RFC Message-ID before contacting Gmail.
Gmail can replace that planned ID. The system preserves it and stores a separate verified delivered Message-ID.
Verification reads the exact Gmail message and thread IDs returned by sending. It checks sender, recipient, content and acceptance time.
Only full-body whitespace is normalized for Gmail line wrapping. Different words, recipients or identities hold reconciliation.
Follow-ups reference the verified delivered ID. Their initial delivery must also have confirmed CRM logging.
A timeout or uncertain response never triggers another send. The worker searches Sent mail for that Message-ID.
A unique match completes the original delivery. No unique match holds the campaign for investigation.
Do not delete uncertain delivery records or change their Message-ID to force a retry.
Successful deliveries use the existing ThreadWriterService for CRM logging. Logging failure retries logging, never sending.

Opt-outs and bounces create permanent campaign suppression rows. Adding a contact back into CompAI does not clear them.

## Spending

The existing Vercel AI Gateway project limit remains US$10 monthly. Context, hosting and storage remain separate.
Research reserves US$0.05 before each bounded Agent API request against a US$10 monthly ledger.
Reported provider costs reconcile the reservation. Missing usage and uncertain failures retain the full reservation.
The request pins `openai/gpt-5.6-luna` with default processing. It uses no preset, fallback model or conversation history.
The provider receives a structural JSON schema. Local Zod validation still enforces URLs, email syntax, text lengths and prospect limits.
Limits are one research step, no parallel tools, 2,500 output tokens and a 16,000-byte serialized request.
The only tool is web search: 10 results, 6,000 context tokens and 1,200 tokens per page.
The September 12, 2026 price estimate uses two model passes: US$0.20/million input tokens and US$1.20/million output tokens.
One search invocation adds US$0.0025. The conservative token estimate totals US$0.0166 before provider prompt overhead.
The US$0.05 reservation includes overhead headroom. It is an estimate, not a provider-enforced dollar ceiling.
An observed cost above the reservation or a changed model or service tier pauses research for review.
Failed or incomplete responses settle reported USD costs but save no prospects. HTTP errors expose safe status and code diagnostics.
Provider error bodies, API keys and source text never enter these diagnostics.
Current contracts: [Agent API](https://docs.perplexity.ai/api-reference/agent-post),
[model prices](https://docs.perplexity.ai/docs/agent-api/models),
[search limits](https://docs.perplexity.ai/docs/agent-api/tools/web-search) and
[tool prices](https://docs.perplexity.ai/docs/getting-started/pricing).
Reply drafting uses GPT-5.4 mini, reserves US$0.10 and checks its published price before calling AI Gateway.
Reply reservations remain conservative charges in the internal ledger. The UI distinguishes confirmed costs from charged or reserved amounts.
Requests use bounded output and no automatic AI retries. Reaching an allowance stops new paid work.
These application ledgers do not change provider subscriptions or enable paid upgrades.

## Verification

Use a separate PostgreSQL database whose name ends in `_test`. Never use the production database for tests.
The outreach integration tests mock all external email and research requests.
They cover leases, manual exclusions, daily limits, uncertain delivery, reply stops, suppression, stale sync and concurrent budget reservations.
Source tests reject unsupported quotations, missing emails and unrelated domains.
Research tests cover Agent output parsing, failed responses, usage accounting, input limits, budget exhaustion and model or price drift.
Policy tests cover Perth time, follow-up timing, template fields and message-header injection.

Controlled live delivery and sender authentication still require verification before launch.

### Controlled Gmail tests

Use **Controlled Gmail tests** on the campaign page while the campaign is paused.
Enter a separate Gmail inbox that Danny controls. Confirm ownership and the two displayed test messages.
The API creates an isolated test contact and durable test records. These records use no pilot allocations.
The test sends one reply request and one opt-out request. It sends no automatic follow-ups.
The daily test limit is two messages. An uncertain send requires reconciliation through **Check results**.
The same batch cannot send twice. Rechecking a test only reconciles delivery, logging and responses.
Existing confirmed sends reconcile through their stored Gmail IDs, including sends whose RFC Message-ID Gmail replaced.
The evidence references show planned and delivered IDs. Receiver headers must match the verified delivered ID.
Pasted receiver headers never establish a delivery identity. Uncertain sends without Gmail IDs still require the planned-ID match.

Reply from the receiving inbox with the requested text. Then check both test results in CompAI.
Copy **Show original** headers from the receiving Gmail inbox into each test's header field.
The stored evidence includes message identity and aligned SPF, DKIM and DMARC results. Raw headers are not stored.
The page verifies Gmail receipt, CRM logging and response classification. It does not exercise a prospect sequence.
Integration tests verify durable sequence stops. The owner records launch checks after reviewing both evidence sets.
These controls never approve templates, mark launch checks complete or start prospect outreach.

The controlled contact permits exact email matching for a personal Gmail inbox.
Ordinary mailbox matching still excludes free-email domains when it creates a thread.
A prospect using such an address needs logging verification before launch. Failed logging holds reconciliation and never resends.

# Geotab prospecting

Open **Agents → Geotab prospecting**. The route is `/sapience-analytics/agents/geotab`.

The campaign starts paused. Creating the campaign does not send email or call research providers.

## Quick use

1. Import sourced candidates or use **Start cloud research**. Wait for official fleet source verification. Use each prospect's **Research contacts** control to verify and select a current contact.
2. Qualify the two prospects you want to email manually first, then the other ten. Qualification records contact eligibility; a public email alone is insufficient.
3. Leave sending paused while AI prepares the initial email and both follow-ups. Drafts can generate before campaign approval.
4. Read all three exact previews for each of the twelve prospects, then choose **Record review of all three previews** on each record.
5. Review and approve the current templates and [AI personalisation policy](geotab-campaign-approval.md). Complete Gmail permissions and launch checks, then use **Start approved pilot**.
6. Copy the two manual prospects' drafts into Gmail and handle their follow-ups yourself. The other ten use automation. You handle all replies, meetings and sales conversations.
7. After the pilot checks pass, use **Accept pilot and start weekly campaign**. Review the weekly report and held records on this page.

Approval alone does not start sending. Held or missing drafts never fall back to template emails. The campaign page shows the current live state.

## Workflow

The agent's minute schedule checks research, source verification, personalised email drafts and reply drafts. Research runs at most hourly.
The Perplexity Agent API finds up to five prospects per request. The weekly target is 50 new WA companies.
The worker verifies source quotations, WA location text and published email addresses against the company's website.
Unverified records stay on hold. Vehicle counts stay unknown during discovery. Plant and employee counts never become vehicle counts.

Verified discoveries automatically queue a separate people search. It prioritizes fleet, transport and operations roles, then suitable company leaders.
The people search shares the existing research ledger and request limits. Pilot contact checks run before unallocated discoveries.
Named contacts require a current official contact block connecting the name, relevant title and exact published work email.
Customer testimonials, former employees, historic policies and another organization's role mailbox do not qualify.
A person and a general footer inbox on the same page do not establish their association.
Known people without associated email remain research notes. Published department inboxes remain generic routing targets.
New, unallocated held discoveries can adopt the best verified candidate before a separate source and eligibility check.
Existing CRM conversations, pilot assignments and selected targets prevent automatic replacement. No search or selection grants consent.

Verified companies and exact published contacts enter CompAI without overwriting existing fields or reassigning existing contacts. Company enrichment is separate from source verification; imported contacts do not trigger paid enrichment.
Recent unanswered CRM emails explicitly requesting Geotab or fleet-tracking contact establish automatic eligibility.
Other prospects require documented consent or an assessed inferred-consent basis. Publication alone never enables sending.
The first two eligible prospects remain manual permanently. The next ten form the automated pilot.

The API's protected five-minute cron handles Gmail. It sends at most one queued message per tick.
Daily limits are 10 initial messages and 30 total messages, weekdays from 10 am to 3 pm Perth time.
Follow-ups fall 4 and 10 weekdays after the initial send. Public holidays are not excluded.
No third follow-up exists. An overdue message waits for the next sending window and available daily capacity.

AI writes short operational openings and questions using verified source facts and the selected contact.
Named contacts receive a verified name greeting and an interest question. Department inboxes receive a team greeting and one routing question.
Approved Geotab capabilities are separate product evidence. They do not establish the recipient's vehicle compatibility, problems or savings.
The first follow-up adds a specific approved use case. Trailer-only evidence does not support recipient engine or fuel claims.
The preview shows an exact supporting source reference for each opening and question; those references are review evidence, not extra text appended to the email. A separate AI review audits grounding and stage intent.
Deterministic checks reject unsupported numbers, commercial claims, added links, placeholders and missing sender identification or unsubscribe instructions.
The approved initial Geotab offer and every signature remain fixed. Generation receives only dynamic slots, stage intent and verified evidence.
Assembly labels and a fictional example separate generated copy from application-owned text. Example facts are never recipient evidence.
The independent grounding review receives all approved templates and all three complete rendered emails.
Three complete messages persist together before any send. The preview and delivery use those exact stored strings.
The pilot requires Danny's review of all three previews for each prospect. Manual prospects receive copyable drafts and remain excluded from sending.
Replies pause the sequence. AI creates a proposed reply in CompAI. Danny reviews and sends it himself.
The worker never sends AI reply drafts. The ordinary Gmail inbox also receives the original reply.
Weekly reports appear on the campaign page. They do not send a separate report email.

## Launch

1. Deploy API first. Its production build applies the additive migration. Then deploy agent and app.
2. Create the paused campaign as `danny@sapienceanalytics.com.au`.
3. Configure the existing `PERPLEXITY_API_KEY` on the agent's Production environment. Never paste the key into chat.
4. Enable cloud research. Review source and eligibility holds in the campaign page.
5. Connect Gmail sending from the campaign page. Existing read permissions remain required; sending is an additional grant.
6. Read the templates and AI personalisation rules. v1.18.0 pauses sending and clears approval of the previous quotation-substitution policy. Qualification and draft generation do not require campaign approval.
7. Record SPF, DKIM, DMARC and controlled delivery, reply-stop, opt-out-stop and CRM logging checks.
8. Qualify the two manual prospects first, then the ten automated prospects. Wait for all three drafts each and record review of their exact previews. Approve the current templates and policy, then start the pilot.
9. Accept the pilot and activate weekly sending after all ten initial deliveries are confirmed and logged.

Research and sending have separate pause controls. Template edits pause sending and revoke approval and launch checks.
Preview deployments and local processes do not run outreach workers. `VERCEL_ENV=production` is required.
Missing research credentials appear as a held research status. They never enable an unmetered fallback.

### Owner candidate intake

Use **Import researched candidates** for an owner-reviewed JSON batch containing at most twelve records.
Provide exact fleet/operation and WA quotations. A separate contact page may supply a published email and role quotation.
Intake creates held, unverified records. It does not grant consent, allocate pilot slots, overwrite company fields or send email.
The agent independently verifies the official website and contact evidence, including published contact addresses on a different mailbox domain. It creates or reuses the exact contact under the verified company. Archived, conflicting or suppressed records remain held without reassignment.
Transient source failures retry after fifteen minutes, with at most three attempts. Importing the same manifest again does not reset a held record or its verification attempts.
Qualification remains a separate owner action recording the relevant role, contact basis and absence of restrictions.

Qualified, unsent prospects have a **Revise source quote** control. Paste stronger exact evidence from the same linked source page.
Saving pauses sending and removes that prospect's draft previews and review. The cloud worker rechecks the quote before new drafting.
The company, source URL, contact, consent and permanent pilot assignment remain unchanged. Other reviewed prospects retain their drafts.
An active verification or drafting lease, suppression, or any delivery record blocks revision. Failed source checks remain unsendable.

### Contact research and selection

Open **Research contacts for [company]**. Search with Perplexity, or paste up to three sourced candidate objects for cloud verification.
Owner-supplied candidates use official website checks without a paid model search. They cannot set their own verified status.
The existing company binding must pass first. Changed-email records with failed contact verification can research replacement candidates.
Only current completed candidates with published email are selectable. Candidate selection expires after one day; selected evidence does not expire daily.
Selection pauses sending and clears that prospect's three drafts and preview review. The cloud verifier rechecks all source evidence and bindings.
Changing email also clears the previous contact eligibility and requires qualification again. Selecting the same email preserves its existing eligibility.
Both actions preserve the company and permanent pilot/manual assignment. Any delivery, stop, suppression or active lease blocks changes.
The new contact-grounded drafting policy invalidates previous previews and clears campaign approval on deployment. Stored templates remain unchanged.
Review new contact targeting, all three exact drafts and the current campaign rules before launch.

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

Draft generation uses durable leases and at most two attempts per input version, separated by a day after failure.
Owner retry is explicit. Unknown-cost calls retain their reservations. Missing, unsafe or incomplete drafts never fall back to templates.
Template, evidence, consent or recipient changes invalidate drafts and their preview review.
Changes after initial delivery hold follow-ups. Existing draft and delivery snapshots are preserved for audit.
Late or concurrent generation cannot commit after its lease expires or inputs change.

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
Sequence generation, grounding reviews and reply drafts share the same US$10 monthly `ai:YYYY-MM` ledger.
Each request reserves US$0.10 before calling GPT-5.4 mini through AI Gateway, with only the OpenAI provider and no fallback.
Current published model pricing must fit the reservation before dispatch. Inputs are bounded to 20,000 UTF-8 bytes plus estimated overhead.
Output caps are 3,000 tokens for three drafts, 3,000 for grounding review and 700 for a reply draft.
Actual Gateway costs settle reservations. Missing usage retains the full reservation; observed overruns pause further CRM drafting for review.
The UI distinguishes confirmed costs from charged or reserved amounts. Provider errors use fixed safe messages.
Requests use bounded output and no automatic AI retries. Reaching an allowance stops new paid work.
These application ledgers do not change provider subscriptions or enable paid upgrades.

## Verification

Use a separate PostgreSQL database whose name ends in `_test`. Never use the production database for tests.
The outreach integration tests mock all external email and research requests.
They cover leases, manual exclusions, daily limits, uncertain delivery, reply stops, suppression, stale sync and concurrent budget reservations.
Source tests reject unsupported quotations, missing emails and unrelated domains.
Research tests cover Agent output parsing, failed responses, usage accounting, input limits, budget exhaustion and model or price drift.
Policy tests cover Perth time, follow-up timing, template fields and message-header injection.
Draft tests cover exact persisted preview/send equality, all-stage atomicity, separate claim references, grounding rejection and pilot preview gates.
They also cover budget sharing, retained unknown costs, cost overruns, bounded retries, lease restarts and mid-generation input drift.
Intake tests cover owner access, deduplication, official source verification, contact evidence and held-state isolation.

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
Campaign prospects require an exact verified contact/company binding before sending. Logging validates that binding without creating identities.
Company and recipient mailbox domains both retain suppression protection. Failed logging holds reconciliation and never resends.

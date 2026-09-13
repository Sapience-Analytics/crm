# Geotab outreach automation

The cloud service researches prospects, verifies contacts, prepares personalised emails, sends approved sequences, and checks replies.
Danny handles sales conversations, meetings, quotes, and closing.

## Owner approval

The owner approves the campaign rules and templates before launch.
The approval covers automatic qualification, one verified referral handoff, and automatic expansion after the pilot observation period.
Changing these rules or templates invalidates approval and existing draft reviews.
The release migration pauses sending and clears the previous approval.

The pilot contains twelve original prospects.
Ten use automated sequences.
The first two keep entirely manual sequences, including follow-ups.
The owner reviews all thirty-six pilot emails before launch.
Later eligible prospects use the approved rules without individual draft approval.

## Automatic prospect progression

1. Hosted research finds source-backed WA businesses with road vehicle operations.
2. Contact research prefers a named fleet, transport, or operations contact with an exact published work email.
3. The service checks company binding, duplicate records, suppression, contact role, and official source evidence.
4. Automatic qualification checks the published operational role and linked contact restrictions.
5. Qualified contacts receive three saved, personalised email drafts.
6. Independent claim review checks each draft before it enters the send queue.

Public email availability alone does not qualify a contact.
General inboxes without published operational-role evidence remain held.
Existing company correspondence, conflicting records, unclear roles, and unavailable source policies require review.
Automatic qualification records the evidence, examined sources, hashes, and assessment time.
It preserves existing owner consent and manual assignments.

The contact-basis rules follow the recorded campaign requirements and [ACMA guidance](https://www.acma.gov.au/avoid-sending-spam).
The [Spam Act](https://www.legislation.gov.au/Series/C2004A01214) defines consent requirements.

## Personalisation

Automatic sequence drafting runs on a separate two-minute schedule; other dispatch work keeps its one-minute schedule.
Every sequence uses verified company facts and the selected contact's published identity.
The introduction links one relevant operation to an approved Geotab capability.
The first follow-up adds a practical use case.
The final follow-up asks a short relevance question and offers to close the conversation.
Named contacts receive an interest question.
Department contacts receive the approved request for the responsible person.

The approved subject, sender identification, product introduction, and unsubscribe instructions remain controlled blocks.
The service saves and sends the exact validated copy.
It does not generate an unchecked replacement during delivery.
It does not invent names, email addresses, fleet sizes, needs, savings, prices, or past conversations.
Personalisation improves relevance; this release makes no conversion-rate claim.

## Referral handoff

Any reply stops that recipient's sequence.
The service records the Gmail message identity and continues checking later messages.

An explicit referral starts a separate assessment.
Automatic handoff requires an authenticated reply in the existing campaign thread.
The reply must identify one different work email at the same company.
Official company evidence must verify the target and any new referring sender.
The target must pass a separate contact-basis assessment.
The service never copies the original recipient's consent.

The original prospect remains stopped with its message history intact.
The child prospect receives fresh personalised drafts and uses the same daily limits.
One referral hop is allowed.
Duplicate contacts, loops, cross-company referrals, multiple targets, and name-only referrals remain held.
Manual pilot prospects never create automatic referral sequences.
A later reply in the original conversation stops its child sequence for review.
Opt-outs, bounces, bookings, and owner stops also stop related company sequences.

## Delivery and expansion

The send window is weekdays, 10 am to 3 pm Perth time.
Daily limits remain ten introductions and thirty campaign emails.
Follow-ups fall four and ten business days after the introduction.
Replies, opt-outs, bounces, and matched bookings stop follow-ups.
Uncertain Gmail results require reconciliation before further sending.
A pause stops new claims; the service cannot recall a message already handed to Gmail.

The pilot expands automatically after all ten automated introductions are sent and logged.
It first observes one business day after the latest introduction.
It also requires fresh mailbox checks for contacts still under monitoring and no uncertain delivery records.
Booked or suppressed contacts remain stopped and do not block expansion solely because their mailbox check is old.
A pilot bounce pauses the campaign for review.
The target then becomes fifty new researched companies each week, subject to qualification and budgets.

## Review and reporting

The CRM review queue shows replies, held referrals, qualification holds, and uncertain deliveries.
Replies receive a draft for Danny to review and send.
The system does not autonomously negotiate, quote, or conduct sales conversations.

Weekly reports record research, eligibility, sends, replies, meetings, holds, and costs.
The report worker catches up missing weeks after downtime.
Eligibility, reply, meeting and held counts reflect the reporting snapshot rather than reconstructed historical states.
Budget totals also reflect the reporting snapshot.

Monthly allowances remain US$10 for CRM AI and US$10 for research.
Each billable request reserves its allowance before dispatch.
Unknown request costs retain their reservation.
Existing hosting and enrichment charges remain separate.
This workflow does not authorise paid upgrades.

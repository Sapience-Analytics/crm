# Geotab campaign — copy and approval

This describes the v1.18.0 AI personalisation policy. The production CRM shows the current templates, previews, approval and sending status; this document does not grant approval.

## Review before launch

1. Keep sending paused. Qualify the two manual prospects first, then the ten automated prospects.
2. Wait for AI to prepare all three messages per prospect. Campaign approval is not required to generate previews.
3. Read each complete preview and its supporting source references. Choose **Record review of all three previews** for every pilot prospect.
4. Approve the current templates and personalisation policy in **Agents → Geotab prospecting**. Once Gmail permissions and launch checks also pass, choose **Start approved pilot**.

The initial message and both follow-ups are stored together. Sending uses those exact stored previews. The two manual prospects stay permanently excluded from automation, including follow-ups.

## What AI writes

AI writes a natural opening and a relevant fleet-needs question for each stage, using verified company facts. Each opening and question has its own exact supporting source reference and must pass an independent AI grounding review.

- Initial email: open a conversation about the recipient's fleet needs.
- Follow-up after four business days: gently revisit that question.
- Final follow-up ten business days after the initial email: offer to leave it there.

The stage templates guide wording and intent. `{{observation}}` is no longer replaced with “Your website says” plus a quotation. Source references appear beside the previews for review; the email itself uses natural personalised wording.

AI must not invent fleet sizes, existing products, problems, buying intent, prices, savings or promises. It cannot add links or an initial booking link. Unsafe, incomplete or unavailable drafts stay held; there is no template fallback.

## Fixed copy

The subject follows the stored subject template; the baseline is `Fleet needs at {{company}}`, using the sourced company name. Follow-ups remain in the initial Gmail thread.

The initial email retains the stored Geotab offer paragraph. The baseline is:

> I’m Danny from Sapience Analytics. We help businesses set up and use Geotab, with local support and reporting that fits their operations.

Every stage retains the current template's signature and unsubscribe instructions:

Danny  
Sapience Analytics  
danny@sapienceanalytics.com.au  
https://sapienceanalytics.com.au

To stop these emails, reply unsubscribe.

## After approval

Approval alone does not start sending. Changing templates pauses sending, clears approval and launch checks, and requires fresh drafts and preview review. Changes to evidence, consent or recipient also invalidate the affected previews; changes after an initial send hold follow-ups.

Replies, opt-outs, bounces and matched bookings stop the sequence. AI drafts responses for Danny to review and send. See the [usage guide](geotab-outreach.md) for timing, budgets and recovery.

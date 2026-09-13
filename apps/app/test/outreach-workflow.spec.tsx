import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CampaignReviewQueue } from "../components/outreach/campaign-review-queue";
import { CampaignWorkflow } from "../components/outreach/campaign-workflow";
import { ProspectWorkflow } from "../components/outreach/prospect-workflow";

test("workflow rendering states approval scope, manual exclusions and unsettled delivery limits", () => {
	const html = renderToStaticMarkup(
		<CampaignWorkflow
			campaign={{
				approved: false,
				deliveries: { inProgress: 2, unconfirmed: 1 },
			}}
		/>,
	);
	expect(html).toContain("Approve the updated workflow before launch");
	expect(html).toContain("automatic eligibility");
	expect(html).toContain("same-company referrals and pilot expansion");
	expect(html).toContain("initial email and both follow-ups");
	expect(html).toContain("two manual pilot prospects stay excluded");
	expect(html).toContain("one business day");
	expect(html).toContain("no pilot bounces and no uncertain deliveries");
	expect(html).toContain("2 emails in progress");
	expect(html).toContain("1 deliveries unconfirmed");
	expect(html).toContain("cannot recall messages already in progress");
	expect(html).toContain("review and send");
	const approved = renderToStaticMarkup(
		<CampaignWorkflow
			campaign={{
				approved: true,
				deliveries: { inProgress: 0, unconfirmed: 0 },
			}}
		/>,
	);
	expect(approved).not.toContain("Approve the updated workflow before launch");
});

test("review queue renders distinct counts and a selected reply view", () => {
	const html = renderToStaticMarkup(
		<CampaignReviewQueue
			counts={{ replies: 1, referrals: 2, qualification: 3, deliveries: 4 }}
			view="replies"
			onViewChange={() => undefined}
		/>,
	);
	expect(html).toContain('aria-label="Prospect review queue"');
	expect(html).toContain('aria-checked="true"');
	expect(html).toContain("Replies to review (1)");
	expect(html).toContain("Referral holds (2)");
	expect(html).toContain("Qualification holds (3)");
	expect(html).toContain("Unsettled sends (4)");
});

test("prospect review shows referral identity and preserves unsafe text as text", () => {
	const prospect: ComponentProps<typeof ProspectWorkflow>["prospect"] = {
		status: "REPLIED",
		email: "operations@example.test",
		eligibilityError: null,
		stoppedAt: "2026-09-14T01:00:00.000Z",
		referredFrom: null,
		replyText: "Please contact Alex. <img src=x onerror=alert(1)>",
		referrals: [
			{
				id: "referral-example",
				status: "HELD",
				reason: "The recipient role requires verification.",
				recipientName: "Alex Example",
				recipientEmail: "alex@example.test",
				createdAt: "2026-09-14T01:00:00.000Z",
			},
		],
		deliveries: [
			{
				id: "delivery-example",
				stage: 1,
				status: "UNKNOWN",
				error: "No unique sent message found.",
				createdAt: "2026-09-14T01:00:00.000Z",
			},
		],
	};
	const html = renderToStaticMarkup(<ProspectWorkflow prospect={prospect} />);
	expect(html).toContain("From operations@example.test to Alex Example");
	expect(html).toContain("alex@example.test");
	expect(html).toContain("Held for review");
	expect(html).toContain("The recipient role requires verification.");
	expect(html).toContain("Original sequence: REPLIED");
	expect(html).toContain("Stopped at 2026-09-14T01:00:00.000Z");
	expect(html).toContain("Follow-up 1: delivery unconfirmed");
	expect(html).toContain("Do not resend this message manually");
	expect(html).toContain(
		"does not send customer conversation replies automatically",
	);
	expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	expect(html).not.toContain("<img");
	expect(html).not.toContain("<script");
	const child = renderToStaticMarkup(
		<ProspectWorkflow
			prospect={{
				...prospect,
				status: "HELD",
				email: "alex@example.test",
				referrals: [],
				deliveries: [],
				replyText: null,
				referredFrom: {
					id: "original-prospect",
					company: "Example Transport",
					email: "operations@example.test",
					status: "REPLIED",
					stoppedAt: "2026-09-14T01:00:00.000Z",
				},
			}}
		/>,
	);
	expect(child).toContain(
		"Example Transport: operations@example.test → alex@example.test",
	);
	expect(child).toContain("cannot start another automatic referral sequence");
});

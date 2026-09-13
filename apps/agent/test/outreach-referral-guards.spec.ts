import { describe, expect, test } from "bun:test";
import { OUTREACH } from "@crm/validation/outreach";
import {
	incomingReferralSchema,
	OUTREACH_AUTOMATION,
	referralDecisionSchema,
} from "@crm/validation/outreach-referrals";
import {
	eligibleReferralDecision,
	eligibleReferralMessage,
	freshReferralText,
	sameCompanyReferralEmail,
} from "../agent/lib/outreach-referral-guards";

const now = new Date("2026-09-14T04:00:00.000Z");
const parent = {
	domain: "fleet.example.test",
	email: "operations@fleet.example.test",
	initialSentAt: new Date("2026-09-10T04:00:00.000Z"),
};
const quote =
	"Please contact Alex Example at alex@fleet.example.test about vehicle tracking.";
const message = incomingReferralSchema.parse({
	messageId: "gmail-referral-message",
	threadId: "gmail-campaign-thread",
	fromEmail: parent.email,
	toEmails: [OUTREACH.sender],
	rfcMessageId: "<referral-message@fleet.example.test>",
	receivedAt: "2026-09-13T04:00:00.000Z",
	body: quote,
	authenticated: true,
	inCampaignThread: true,
});
const decision = referralDecisionSchema.parse({
	kind: "referral",
	email: "alex@fleet.example.test",
	name: "Alex Example",
	quote,
});

describe("referral message provenance", () => {
	test("accepts a current authenticated same-company message in the campaign thread", () => {
		expect(eligibleReferralMessage(message, parent, now)).toBe(true);
		expect(eligibleReferralDecision(decision, message, parent)).toBe(true);
	});

	test.each([
		{ authenticated: false },
		{ inCampaignThread: false },
		{ rfcMessageId: null },
		{ toEmails: ["someoneelse@sapienceanalytics.com.au"] },
		{ toEmails: [OUTREACH.sender, "someoneelse@sapienceanalytics.com.au"] },
		{ fromEmail: OUTREACH.sender },
		{ fromEmail: "outsider@unrelated.example.test" },
	])("rejects untrusted message provenance %j", (change) => {
		const changed = incomingReferralSchema.parse({ ...message, ...change });
		expect(eligibleReferralMessage(changed, parent, now)).toBe(false);
	});

	test.each([
		"messageId",
		"threadId",
		"authenticated",
		"inCampaignThread",
		"rfcMessageId",
		"toEmails",
	])("rejects a message missing required %s at the input boundary", (field) => {
		expect(
			incomingReferralSchema.safeParse({ ...message, [field]: undefined })
				.success,
		).toBe(false);
	});

	test.each([
		{ threadId: "" },
		{ toEmails: [] },
		{ rfcMessageId: "<valid>\r\nBcc: stranger@example.test" },
	])("rejects malformed message identity %j", (change) => {
		expect(
			incomingReferralSchema.safeParse({ ...message, ...change }).success,
		).toBe(false);
	});

	test.each(["2026-09-14T04:00:00.001Z", "2026-09-10T03:59:59.999Z"])(
		"rejects future or pre-send receipt %s",
		(receivedAt) => {
			expect(
				eligibleReferralMessage(
					incomingReferralSchema.parse({ ...message, receivedAt }),
					parent,
					now,
				),
			).toBe(false);
		},
	);

	test("rejects stale referrals while accepting the exact age boundary", () => {
		const boundary = now.getTime() - OUTREACH_AUTOMATION.referralMaxAgeMs;
		const olderParent = {
			...parent,
			initialSentAt: new Date(boundary - OUTREACH.dayMs),
		};
		for (const [offset, expected] of [
			[0, true],
			[-1, false],
		] as const) {
			const changed = incomingReferralSchema.parse({
				...message,
				receivedAt: new Date(boundary + offset).toISOString(),
			});
			expect(eligibleReferralMessage(changed, olderParent, now)).toBe(expected);
		}
	});

	test("accepts exact send and current-time boundaries", () => {
		for (const receivedAt of [
			parent.initialSentAt.toISOString(),
			now.toISOString(),
		])
			expect(
				eligibleReferralMessage(
					incomingReferralSchema.parse({ ...message, receivedAt }),
					parent,
					now,
				),
			).toBe(true);
	});

	test.each([
		{ ...parent, email: null },
		{ ...parent, initialSentAt: null },
	])("requires the original recipient and initial send %j", (identity) =>
		expect(eligibleReferralMessage(message, identity, now)).toBe(false),
	);

	test.each([
		"Out of office.",
		"Out of the office.",
		"Automatic reply.",
		"Auto-reply.",
		"Please unsubscribe.",
		"Remove me.",
		"Stop emailing.",
		"Do not contact me.",
		"Not interested.",
	])("rejects an automatic reply or stop request: %s", (prefix) => {
		const changed = incomingReferralSchema.parse({
			...message,
			body: `${prefix}\n${quote}`,
		});
		expect(eligibleReferralMessage(changed, parent, now)).toBe(false);
	});
});

describe("explicit referral identity", () => {
	test("accepts a matching mailto address and normalizes parsed address casing", () => {
		const mailtoQuote =
			"Please email Alex Example at mailto:ALEX@FLEET.EXAMPLE.TEST.";
		const changed = incomingReferralSchema.parse({
			...message,
			body: mailtoQuote,
			fromEmail: "OPERATIONS@FLEET.EXAMPLE.TEST",
		});
		const selected = referralDecisionSchema.parse({
			...decision,
			email: "ALEX@FLEET.EXAMPLE.TEST",
			quote: mailtoQuote,
		});
		expect(eligibleReferralMessage(changed, parent, now)).toBe(true);
		expect(eligibleReferralDecision(selected, changed, parent)).toBe(true);
	});

	test.each([
		{ email: "fabricated@fleet.example.test" },
		{ name: "Invented Person" },
		{
			quote:
				"Please contact Alex Example at alex@fleet.example.test about fuel tracking.",
		},
		{
			quote:
				"Please contact Alex Example at invented@fleet.example.test about vehicle tracking.",
		},
	])("rejects fabricated or altered decision evidence %j", (change) => {
		const selected = referralDecisionSchema.parse({ ...decision, ...change });
		expect(eligibleReferralDecision(selected, message, parent)).toBe(false);
	});

	test("rejects mailto and body address disagreement", () => {
		const body =
			"Please email Alex Example at alex@fleet.example.test using mailto:other@fleet.example.test.";
		const changed = incomingReferralSchema.parse({ ...message, body });
		const selected = referralDecisionSchema.parse({ ...decision, quote: body });
		expect(eligibleReferralDecision(selected, changed, parent)).toBe(false);
	});

	test.each([
		`${quote} Or contact Taylor at taylor@fleet.example.test.`,
		`${quote}\nTaylor is available at taylor@fleet.example.test.`,
	])("rejects multiple target addresses in the fresh body: %s", (body) => {
		const changed = incomingReferralSchema.parse({ ...message, body });
		expect(eligibleReferralDecision(decision, changed, parent)).toBe(false);
	});

	test.each([parent.email, OUTREACH.sender, "colleague@fleet.example.test"])(
		"rejects referral back to the original recipient or message sender: %s",
		(email) => {
			const body = `Please contact Alex Example at ${email} about vehicle tracking.`;
			const changed = incomingReferralSchema.parse({
				...message,
				body,
				fromEmail:
					email === "colleague@fleet.example.test" ? email : message.fromEmail,
			});
			const selected = referralDecisionSchema.parse({
				...decision,
				email,
				quote: body,
			});
			expect(eligibleReferralDecision(selected, changed, parent)).toBe(false);
		},
	);

	test.each([
		"alex@unrelated.example.test",
		"alex@sub.fleet.example.test",
		"alex@fleet.example.test.attacker.test",
	])("rejects a different company email domain: %s", (email) => {
		const body = `Please contact Alex Example at ${email} about vehicle tracking.`;
		const changed = incomingReferralSchema.parse({ ...message, body });
		const selected = referralDecisionSchema.parse({
			...decision,
			email,
			quote: body,
		});
		expect(sameCompanyReferralEmail(email, parent)).toBe(false);
		expect(eligibleReferralDecision(selected, changed, parent)).toBe(false);
	});

	test("accepts the current authorized alternate company mailbox domain", () => {
		const alternateParent = {
			...parent,
			email: "operations@fleet-group.example.test",
		};
		const body =
			"Please contact Alex Example at alex@fleet-group.example.test about vehicle tracking.";
		const changed = incomingReferralSchema.parse({
			...message,
			fromEmail: alternateParent.email,
			body,
		});
		const selected = referralDecisionSchema.parse({
			...decision,
			email: "alex@fleet-group.example.test",
			quote: body,
		});
		expect(eligibleReferralMessage(changed, alternateParent, now)).toBe(true);
		expect(
			sameCompanyReferralEmail(
				"alex@fleet-group.example.test",
				alternateParent,
			),
		).toBe(true);
		expect(eligibleReferralDecision(selected, changed, alternateParent)).toBe(
			true,
		);
	});

	test.each([
		"Alex Example is available at alex@fleet.example.test.",
		"Do not contact Alex Example at alex@fleet.example.test.",
		"Don't email Alex Example at alex@fleet.example.test.",
		"Avoid contacting Alex Example at alex@fleet.example.test.",
	])("rejects a publication or forbidden contact instruction: %s", (body) => {
		const changed = incomingReferralSchema.parse({ ...message, body });
		const selected = referralDecisionSchema.parse({ ...decision, quote: body });
		expect(eligibleReferralDecision(selected, changed, parent)).toBe(false);
	});

	test("does not promote the model's no-referral decision", () => {
		const none = referralDecisionSchema.parse({
			kind: "none",
			reason: "uncertain-request",
		});
		expect(eligibleReferralDecision(none, message, parent)).toBe(false);
	});
});

describe("fresh reply boundaries", () => {
	test.each([
		"On Monday, Alex wrote:",
		">",
		"-----Original Message-----",
		"-----Forwarded Message-----",
		"Begin forwarded message:",
		"From: Alex Example",
		"Sent from my phone",
		"--",
	])("rejects referral evidence taken from history after %s", (separator) => {
		const changed = incomingReferralSchema.parse({
			...message,
			body: `Thanks.\n${separator}\n${quote}`,
		});
		expect(freshReferralText(changed.body)).toBe("Thanks.");
		expect(eligibleReferralDecision(decision, changed, parent)).toBe(false);
	});

	test("ignores quoted targets and opt-outs after a valid fresh referral", () => {
		const changed = incomingReferralSchema.parse({
			...message,
			body: `${quote}\nOn Monday, Alex wrote:\nUnsubscribe. Contact other@fleet.example.test.`,
		});
		expect(freshReferralText(changed.body)).toBe(quote);
		expect(eligibleReferralMessage(changed, parent, now)).toBe(true);
		expect(eligibleReferralDecision(decision, changed, parent)).toBe(true);
	});

	test("rejects a message containing only quoted referral history", () => {
		const changed = incomingReferralSchema.parse({
			...message,
			body: `> ${quote}`,
		});
		expect(freshReferralText(changed.body)).toBe("");
		expect(eligibleReferralMessage(changed, parent, now)).toBe(false);
		expect(eligibleReferralDecision(decision, changed, parent)).toBe(false);
	});
});

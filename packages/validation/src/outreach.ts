import { z } from "zod";

export const OUTREACH = {
	id: "geotab-wa",
	sender: "danny@sapienceanalytics.com.au",
	minuteMs: 60_000,
	dayMs: 86_400_000,
	offsetMs: 8 * 3_600_000,
	leaseMs: 5 * 60_000,
	timeoutMs: 30_000,
	weeklyTarget: 50,
	pilotSize: 12,
	manualSize: 2,
	dailyInitial: 10,
	dailyTotal: 30,
	startHour: 10,
	endHour: 15,
	followupDays: [0, 4, 10],
	monthlyMicroUsd: 10_000_000,
	researchReserveMicroUsd: 50_000,
	aiReserveMicroUsd: 100_000,
	maxResearchTokens: 2500,
	maxSourceBytes: 500_000,
	consentLookbackDays: 90,
	replyModel: "openai/gpt-5.4-mini",
	bookingUrl: "https://calendar.app.google/sQo7CLSshEF5xWzo9",
} as const;

export const outreachReportSchema = z.object({
	researched: z.number().int(),
	eligible: z.number().int(),
	sent: z.number().int(),
	replies: z.number().int(),
	meetings: z.number().int(),
	held: z.number().int(),
	monthlyCostsAtReportTime: z.array(
		z.object({
			id: z.string(),
			reservedMicroUsd: z.number(),
			actualMicroUsd: z.number(),
		}),
	),
});

export const templatesSchema = z
	.object({
		subject: z
			.string()
			.trim()
			.min(1)
			.max(180)
			.regex(/^[^\r\n]+$/),
		initial: z.string().trim().min(30).max(2500),
		followup1: z.string().trim().min(20).max(2500),
		followup2: z.string().trim().min(20).max(2500),
		signature: z.string().trim().min(20).max(1000),
	})
	.refine(
		(value) =>
			Object.values(value).every((text) =>
				[...text.matchAll(/\{\{(.*?)\}\}/g)].every((match) =>
					["company", "observation"].includes(match[1] ?? ""),
				),
			),
		"Unsupported template placeholder",
	);

export const DEFAULT_TEMPLATES = templatesSchema.parse({
	subject: "Fleet needs at {{company}}",
	initial:
		"Hi,\n\nI came across {{company}} while researching WA fleet operators. {{observation}}\n\nI’m Danny from Sapience Analytics. We help businesses set up and use Geotab, with local support and reporting that fits their operations.\n\nIs there anything you would like to improve about how you track and manage your vehicles today?",
	followup1:
		"Hi,\n\nFollowing up on my question about fleet needs at {{company}}. Are vehicle visibility, reporting or the support you receive areas you are looking to improve?\n\nHappy to understand what you need first.",
	followup2:
		"Hi,\n\nOne last follow-up about fleet needs at {{company}}. Is this something you are reviewing, or should I leave it here for now?\n\nThanks for your time.",
	signature:
		"Danny\nSapience Analytics\ndanny@sapienceanalytics.com.au\nhttps://sapienceanalytics.com.au\n\nTo stop these emails, reply unsubscribe.",
});

export const evidenceSchema = z.object({
	company: z
		.string()
		.trim()
		.min(2)
		.max(160)
		.regex(/^[^\r\n]+$/),
	domain: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
	email: z.email().toLowerCase().nullable(),
	industry: z.string().min(2).max(120),
	fleetBand: z.enum(["1–10", "11–50", "51–200", "201+", "unknown"]),
	fleetEvidence: z.string().max(1000),
	fit: z.string().min(20).max(1500),
	sourceUrl: z.url().refine((url) => url.startsWith("https://")),
	sourceQuote: z.string().min(20).max(600),
	contactSourceUrl: z
		.url()
		.refine((url) => url.startsWith("https://"))
		.optional(),
	contactRoleQuote: z.string().min(5).max(600).optional(),
	waQuote: z.string().min(5).max(300),
	checkedAt: z.iso.datetime(),
	verified: z.boolean(),
});
export type ProspectEvidence = z.infer<typeof evidenceSchema>;
export const researchResultSchema = z.object({
	prospects: z
		.array(evidenceSchema.omit({ checkedAt: true, verified: true }))
		.max(5),
});
export const consentSchema = z.object({
	kind: z.enum(["express", "existing-relationship", "published-business-role"]),
	evidence: z.string().trim().min(30).max(3000),
	source: z.string().trim().min(5).max(1000),
	roleRelevant: z.literal(true),
	noRestriction: z.literal(true),
	verifiedBy: z.string().min(1),
	verifiedAt: z.iso.datetime(),
});
export const readinessSchema = z.object({
	spf: z.literal(true),
	dkim: z.literal(true),
	dmarc: z.literal(true),
	controlledDelivery: z.literal(true),
	replyStop: z.literal(true),
	optOutStop: z.literal(true),
	logging: z.literal(true),
	evidence: z.string().min(30).max(4000),
});

export function perthDay(now: Date): string {
	return new Date(now.getTime() + OUTREACH.offsetMs).toISOString().slice(0, 10);
}

export function weekStart(now: Date): Date {
	const local = new Date(`${perthDay(now)}T00:00:00Z`);
	local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
	return new Date(local.getTime() - OUTREACH.offsetMs);
}

export function sendWindow(now: Date): boolean {
	const local = new Date(now.getTime() + OUTREACH.offsetMs);
	return (
		local.getUTCDay() > 0 &&
		local.getUTCDay() < 6 &&
		local.getUTCHours() >= OUTREACH.startHour &&
		local.getUTCHours() < OUTREACH.endHour
	);
}

export function followupDue(initial: Date, stage: number): Date {
	const days = OUTREACH.followupDays[stage];
	if (days === undefined) throw new Error("Invalid sequence stage");
	const result = new Date(initial);
	let remaining = days;
	while (remaining > 0) {
		result.setTime(result.getTime() + OUTREACH.dayMs);
		const day = new Date(result.getTime() + OUTREACH.offsetMs).getUTCDay();
		if (day !== 0 && day !== 6) remaining -= 1;
	}
	return result;
}

export function renderEmail(
	templates: z.infer<typeof templatesSchema>,
	evidence: ProspectEvidence,
	stage: number,
) {
	const replace = (text: string) =>
		text
			.replaceAll("{{company}}", evidence.company)
			.replaceAll(
				"{{observation}}",
				`Your website says: “${evidence.sourceQuote}”`,
			);
	const body = [templates.initial, templates.followup1, templates.followup2][
		stage
	];
	if (!body) throw new Error("Invalid sequence stage");
	return {
		subject: replace(templates.subject),
		body: `${replace(body)}\n\n${templates.signature}`,
	};
}

export function contactEligible(
	evidence: ProspectEvidence,
	consent: z.infer<typeof consentSchema> | null,
) {
	return evidence.verified && evidence.email !== null && consent !== null;
}

export function stopReason(
	from: string,
	body: string,
): "BOUNCED" | "SUPPRESSED" | "REPLIED" {
	if (
		/mailer-daemon|postmaster/i.test(from) ||
		/delivery status notification|undeliverable/i.test(body)
	)
		return "BOUNCED";
	if (
		/\bunsubscribe\b|\bremove me\b|\bstop emailing\b|\bdo not contact\b/i.test(
			body,
		)
	)
		return "SUPPRESSED";
	return "REPLIED";
}

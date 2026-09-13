import { z } from "zod";
import { OUTREACH } from "./outreach";

export const OUTREACH_AUTOMATION = {
	version: 1,
	pilotObservationBusinessDays: 1,
	maxReferralDepth: 1,
	referralsPerTick: 1,
	referralMaxAttempts: 3,
	referralRetryMs: 15 * OUTREACH.minuteMs,
	referralMaxOutputTokens: 1200,
	referralMaxBodyChars: 8000,
	referralMaxAgeMs: OUTREACH.consentLookbackDays * OUTREACH.dayMs,
	eligibility: {
		maxAgeMs: OUTREACH.dayMs,
		retryMs: OUTREACH.dayMs,
		scanLimit: 20,
		policyPageLimit: 6,
	},
} as const;

export const incomingReferralSchema = z
	.object({
		messageId: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9_-]+$/),
		threadId: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9_-]+$/),
		fromEmail: z.email().toLowerCase(),
		toEmails: z.array(z.email().toLowerCase()).min(1).max(30),
		rfcMessageId: z
			.string()
			.min(1)
			.max(998)
			.regex(/^[^\r\n]+$/)
			.nullable(),
		receivedAt: z.iso.datetime(),
		body: z.string().min(1).max(OUTREACH_AUTOMATION.referralMaxBodyChars),
		authenticated: z.boolean(),
		inCampaignThread: z.boolean(),
	})
	.strict();

export const referralDecisionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("none"),
			reason: z.enum([
				"no-explicit-referral",
				"multiple-recipients",
				"uncertain-request",
			]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("referral"),
			email: z.email().toLowerCase(),
			name: z
				.string()
				.trim()
				.min(3)
				.max(120)
				.regex(/^[\p{L}\p{M}][\p{L}\p{M} .'’-]+$/u)
				.nullable(),
			quote: z.string().trim().min(10).max(1200),
		})
		.strict(),
]);

export type IncomingReferral = z.infer<typeof incomingReferralSchema>;
export type ReferralDecision = z.infer<typeof referralDecisionSchema>;

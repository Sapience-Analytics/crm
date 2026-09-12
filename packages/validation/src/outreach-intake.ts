import { z } from "zod";
import { evidenceSchema, OUTREACH } from "./outreach";

export const OUTREACH_INTAKE = {
	maxCandidates: 12,
	perTick: 3,
	maxAttempts: 3,
	retryMs: 15 * OUTREACH.minuteMs,
	maxManifestChars: 100_000,
	maxObfuscatedEmailChars: 642,
	pendingReason:
		"Source verification is queued. Contact eligibility still needs evidence.",
	verifiedReason:
		"Source verification passed. Contact eligibility still needs evidence.",
	failedReason:
		"Official source verification failed. The prospect stays on hold.",
	exhaustedReason:
		"Source verification stopped after three attempts. The prospect stays on hold.",
	bindingReason:
		"Verified contact binding needs review. An existing or suppressed record conflicts with this prospect.",
	revisionReason:
		"Revised source quote is queued for verification. Draft previews need a new review.",
	revisionVerifiedReason:
		"Revised source verification passed. New AI drafts and preview review are required.",
} as const;

export const intakeCandidateSchema = evidenceSchema
	.omit({ checkedAt: true, verified: true })
	.extend({
		domain: evidenceSchema.shape.domain.transform((value) =>
			value.replace(/^www\./, ""),
		),
		fleetBand: z.literal("unknown"),
		fleetEvidence: z.literal("unknown"),
	})
	.strict()
	.refine(
		(value) =>
			(!value.contactSourceUrl && !value.contactRoleQuote) ||
			Boolean(value.contactSourceUrl && value.contactRoleQuote && value.email),
		"A separate contact source needs its exact role quote and published email.",
	);

export const importCandidatesInput = z
	.object({
		prospects: z
			.array(intakeCandidateSchema)
			.min(1)
			.max(OUTREACH_INTAKE.maxCandidates),
	})
	.strict();

export const importCandidatesOutput = z.object({
	queued: z.number().int().nonnegative(),
	duplicates: z.number().int().nonnegative(),
	rows: z.array(
		z.object({
			id: z.string(),
			company: z.string(),
			domain: z.string(),
			status: z.enum(["queued", "duplicate"]),
		}),
	),
});

export const reviseSourceQuoteInput = z
	.object({
		id: z.string().min(1).max(100),
		sourceQuote: z.string().trim().pipe(evidenceSchema.shape.sourceQuote),
	})
	.strict();

export const reviseSourceQuoteOutput = z.object({ ok: z.literal(true) });

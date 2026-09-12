import { z } from "zod";
import {
	OUTREACH,
	type ProspectEvidence,
	renderEmail,
	type templatesSchema,
} from "./outreach";

export const PERSONALISATION = {
	version: "natural-grounded-v1",
	intent:
		"Ask about fleet needs. Preserve the approved Geotab offer. Never assume a need, fleet size, saving, price or existing product.",
	grounding:
		"Natural opening and question in every stage; exact source references and an independent grounding review are required.",
	identity:
		"Preserve the approved sender signature and unsubscribe text. No added links or initial booking link.",
} as const;

export const DRAFTING = {
	model: OUTREACH.replyModel,
	maxOutputTokens: 3000,
	reviewOutputTokens: 600,
	replyOutputTokens: 700,
	maxInputBytes: 20_000,
	inputOverheadTokens: 1000,
	maxAttempts: 2,
	scanLimit: 20,
	refreshMs: OUTREACH.minuteMs * 60,
	retryMs: OUTREACH.dayMs,
} as const;

const generatedStage = z
	.object({
		stage: z.number().int().min(0).max(2),
		opening: z.string().trim().min(20).max(500),
		question: z.string().trim().min(20).max(350),
		openingSourceQuote: z.string().trim().min(10).max(600),
		questionSourceQuote: z.string().trim().min(10).max(600),
	})
	.strict();
export const generatedSequenceSchema = z
	.object({
		stages: z
			.array(generatedStage)
			.length(3)
			.refine(
				(stages) => stages.every((stage, index) => stage.stage === index),
				"All three stages must be ordered",
			),
	})
	.strict();
export const groundingReviewSchema = z
	.object({
		grounded: z.boolean(),
		intentPreserved: z.boolean(),
		noUnsupportedClaims: z.boolean(),
		stages: z
			.array(
				z
					.object({
						opening: z.boolean(),
						question: z.boolean(),
						intent: z.boolean(),
					})
					.strict(),
			)
			.length(3),
	})
	.strict();
export const persistedStageSchema = generatedStage.extend({
	subject: z
		.string()
		.min(1)
		.max(180)
		.regex(/^[^\r\n]+$/),
	body: z.string().min(30).max(5000),
});
export const draftArtifactSchema = z.object({
	version: z.literal(PERSONALISATION.version),
	inputHash: z.string().length(64),
	campaignHash: z.string().length(64),
	model: z.literal(DRAFTING.model),
	groundingReviewed: z.literal(true),
	stages: z
		.array(persistedStageSchema)
		.length(3)
		.refine((stages) => stages.every((stage, index) => stage.stage === index)),
});
export const draftViewSchema = z.object({
	status: z.string(),
	hold: z.string().nullable(),
	generatedAt: z.string().nullable(),
	model: z.string().nullable(),
	reviewHash: z.string().nullable(),
	reviewedAt: z.string().nullable(),
	stages: z.array(persistedStageSchema),
});

export class DraftValidationError extends Error {}

export function groundedSequence(
	sequence: z.infer<typeof generatedSequenceSchema>,
	templates: z.infer<typeof templatesSchema>,
	evidence: ProspectEvidence,
) {
	if (!evidence.verified)
		throw new DraftValidationError(
			"Verified source evidence is required for AI drafts.",
		);
	if (
		!templates.signature.includes(OUTREACH.sender) ||
		!/reply unsubscribe/i.test(templates.signature)
	)
		throw new DraftValidationError(
			"The approved signature must retain sender identity and unsubscribe instructions.",
		);
	const offer = templates.initial
		.split(/\n\s*\n/)
		.find(
			(paragraph) =>
				paragraph.includes("Sapience Analytics") &&
				paragraph.includes("Geotab"),
		);
	if (!offer)
		throw new DraftValidationError(
			"The initial template must retain the approved Sapience Analytics and Geotab offer paragraph.",
		);
	return sequence.stages.map((stage) => {
		const dynamic = `${stage.opening} ${stage.question}`;
		if (
			![stage.openingSourceQuote, stage.questionSourceQuote].every((quote) =>
				evidence.sourceQuote.includes(quote),
			)
		)
			throw new DraftValidationError(
				"AI draft source references are not exact verified evidence.",
			);
		if (
			/[\d$€£%]|https?:|www\.|[\w.+-]+@[\w.-]+|\{\{|\}\}|\b(?:save|savings|discount|cheaper|guarantee|price|pricing|costs?|affordable|free trial)\b/i.test(
				dynamic,
			)
		)
			throw new DraftValidationError(
				"AI draft includes a prohibited number, commercial claim, link or placeholder.",
			);
		if (
			/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|dozen)\s+(?:\w+\s+)?(?:vehicles|trucks|vans|utes|fleet)\b/i.test(
				dynamic,
			)
		)
			throw new DraftValidationError(
				"AI draft includes an unsupported fleet quantity.",
			);
		if (
			!stage.question.endsWith("?") ||
			stage.question.includes("\n") ||
			stage.opening.includes("\n")
		)
			throw new DraftValidationError(
				"AI drafts require one opening paragraph and a fleet-needs question.",
			);
		if (
			/your website says|ignore .*instructions|system prompt|as an ai/i.test(
				dynamic,
			)
		)
			throw new DraftValidationError(
				"AI draft did not produce suitable personalised copy.",
			);
		const subject = renderEmail(templates, evidence, stage.stage).subject;
		const body = [
			"Hi,",
			stage.opening,
			...(stage.stage === 0 ? [offer] : []),
			stage.question,
			templates.signature,
		].join("\n\n");
		if (
			stage.stage === 0 &&
			(body.includes(OUTREACH.bookingUrl) ||
				subject.includes(OUTREACH.bookingUrl))
		)
			throw new DraftValidationError(
				"Initial emails cannot introduce the booking link.",
			);
		return persistedStageSchema.parse({ ...stage, subject, body });
	});
}

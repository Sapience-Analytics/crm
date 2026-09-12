import { z } from "zod";
import {
	OUTREACH,
	type ProspectEvidence,
	renderEmail,
	type templatesSchema,
} from "./outreach";
import { contactTargetSchema } from "./outreach-contact-target";

export const OUTREACH_PRODUCT_CAPABILITIES = [
	{
		id: "trips",
		fact: "Geotab provides vehicle locations and trip history for reviewing vehicle activity.",
		sourceUrl: "https://www.geotab.com/au/",
	},
	{
		id: "fuel",
		fact: "Geotab provides fuel-consumption and idling reports where supported vehicle data is available.",
		sourceUrl:
			"https://www.geotab.com/au/fleet-management-solutions/fleet-optimisation/",
	},
	{
		id: "maintenance",
		fact: "Geotab supports maintenance planning, scheduling and reminders, with engine-fault information where supported vehicle data is available.",
		sourceUrl:
			"https://www.geotab.com/au/fleet-management-solutions/fleet-maintenance/",
	},
] as const;

export const DEPARTMENT_QUESTIONS = [
	"Could you point me to the person responsible for vehicle tracking or fleet reporting?",
	"Who would be the right person to speak with about vehicle tracking or fleet reporting?",
	"Could you point me to the right person, or should I leave it there?",
] as const;

export const PERSONALISATION = {
	version: "contact-grounded-v2",
	intent:
		"Use a selected verified contact. Ask a named decision-maker one relevant reporting interest question, or ask a department to identify the responsible person. Preserve the approved Geotab offer.",
	grounding:
		"Ground recipient claims in exact company evidence. Ground product claims separately in approved capabilities. Add one useful capability in the first follow-up; avoid repeated fleet lists and vague fleet-needs wording.",
	identity:
		"Only the selected verified contact supplies a personal greeting. Preserve the sender signature and unsubscribe text. No unsupported names, needs, quantities, savings, prices, products or added links.",
	productCapabilities: OUTREACH_PRODUCT_CAPABILITIES,
} as const;

export const DRAFTING = {
	model: OUTREACH.replyModel,
	maxOutputTokens: 3000,
	reviewOutputTokens: 3000,
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

export function verifiedDraftTarget(evidence: ProspectEvidence) {
	const target = contactTargetSchema.safeParse(evidence.contactTarget);
	if (
		!target.success ||
		!evidence.email ||
		target.data.email !== evidence.email ||
		new Date(target.data.checkedAt).getTime() > Date.now()
	)
		throw new DraftValidationError(
			"A current verified contact target matching the recipient is required for AI drafts.",
		);
	if (
		target.data.kind === "named" &&
		(!target.data.name ||
			!/^[\p{L}\p{M}][\p{L}\p{M}'’ .-]*$/u.test(target.data.name) ||
			!target.data.associationQuote
				.toLocaleLowerCase()
				.includes(target.data.name.toLocaleLowerCase()))
	)
		throw new DraftValidationError(
			"The selected contact name requires matching verified publication evidence.",
		);
	return target.data;
}

function comparableCopy(value: string) {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export function groundedSequence(
	sequence: z.infer<typeof generatedSequenceSchema>,
	templates: z.infer<typeof templatesSchema>,
	evidence: ProspectEvidence,
) {
	if (!evidence.verified)
		throw new DraftValidationError(
			"Verified source evidence is required for AI drafts.",
		);
	const target = verifiedDraftTarget(evidence);
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
	const offerSentences = offer
		.split(/[.!?](?:\s+|$)/)
		.map(comparableCopy)
		.filter(Boolean);
	return sequence.stages.map((stage) => {
		const stageLabel = `Stage ${stage.stage}`;
		const dynamic = `${stage.opening} ${stage.question}`;
		if (
			/\bSapience\s+Analytics\b|\b(?:I['’]m|I am|my name is|this is)\s+Danny\b|\bDanny\s+from\b/i.test(
				dynamic,
			) ||
			/\b(?:I|we)\s+(?:(?:can|will)\s+)?(?:help|support|assist|provide|offer|implement|supply)\b[^.!?\r\n]*\bGeotab\b/i.test(
				dynamic,
			) ||
			offerSentences.some((sentence) =>
				comparableCopy(dynamic).includes(sentence),
			)
		)
			throw new DraftValidationError(
				`${stageLabel}: AI draft repeats the fixed sender introduction or Geotab offer.`,
			);
		if (
			![stage.openingSourceQuote, stage.questionSourceQuote].every((quote) =>
				evidence.sourceQuote.includes(quote),
			)
		)
			throw new DraftValidationError(
				`${stageLabel}: AI draft source references are not exact verified evidence.`,
			);
		if (
			/[\d$€£%]|https?:|www\.|[\w.+-]+@[\w.-]+|\{\{|\}\}|\b(?:save|savings|discount|cheaper|guarantee|price|pricing|costs?|affordable|free trial)\b/i.test(
				dynamic,
			)
		)
			throw new DraftValidationError(
				`${stageLabel}: AI draft includes a prohibited number, commercial claim, link or placeholder.`,
			);
		if (
			/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|dozen)\s+(?:\w+\s+)?(?:vehicles|trucks|vans|utes|fleet)\b/i.test(
				dynamic,
			)
		)
			throw new DraftValidationError(
				`${stageLabel}: AI draft includes an unsupported fleet quantity.`,
			);
		if (stage.opening.includes("\n"))
			throw new DraftValidationError(
				`${stageLabel}: AI drafts require one opening paragraph and one interest or routing question. Opening contains a line break.`,
			);
		if (stage.question.includes("\n"))
			throw new DraftValidationError(
				`${stageLabel}: AI drafts require one opening paragraph and one interest or routing question. Question contains a line break.`,
			);
		if (!stage.question.endsWith("?"))
			throw new DraftValidationError(
				`${stageLabel}: AI drafts require one opening paragraph and one interest or routing question. Question must end with '?'.`,
			);
		if (
			/your website says|ignore .*instructions|system prompt|as an ai/i.test(
				dynamic,
			)
		)
			throw new DraftValidationError(
				`${stageLabel}: AI draft did not produce suitable personalised copy.`,
			);
		if (
			stage.opening.includes("?") ||
			(stage.question.match(/\?/g) ?? []).length !== 1
		)
			throw new DraftValidationError(
				`${stageLabel}: AI drafts require exactly one question.`,
			);
		if (
			target.kind === "department" &&
			stage.question !== DEPARTMENT_QUESTIONS[stage.stage]
		)
			throw new DraftValidationError(
				`${stageLabel}: Department emails require the approved routing question.`,
			);
		if (
			stage.stage === 1 &&
			!/\b(?:trip (?:history|reports?)|fuel (?:use|consumption|reports?)|idling (?:data|reports?)|maintenance (?:planning|scheduling|reminders?)|engine fault(?:s| codes?| information)?)\b/i.test(
				dynamic,
			)
		)
			throw new DraftValidationError(
				`${stageLabel}: The first follow-up requires one relevant approved product use case.`,
			);
		if (
			stage.stage === 2 &&
			!/\b(?:leave it (?:there|here)|stop (?:following up|contacting|emailing))\b/i.test(
				stage.question,
			)
		)
			throw new DraftValidationError(
				`${stageLabel}: The final question must offer to stop following up.`,
			);
		if (
			/\b(?:trailers?|doll(?:y|ies|ys))\b/i.test(evidence.sourceQuote) &&
			!/\b(?:trucks?|prime movers?|motor vehicles?|tankers?)\b/i.test(
				evidence.sourceQuote,
			) &&
			/\b(?:engine|fuel|idling)\b/i.test(dynamic)
		)
			throw new DraftValidationError(
				`${stageLabel}: Trailer-only evidence cannot support engine, fuel or idling use cases.`,
			);
		const subject = renderEmail(templates, evidence, stage.stage).subject;
		const body = [
			target.kind === "named"
				? `Hi ${target.name?.split(/\s+/)[0]},`
				: "Hi team,",
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
				`${stageLabel}: Initial emails cannot introduce the booking link.`,
			);
		return persistedStageSchema.parse({ ...stage, subject, body });
	});
}

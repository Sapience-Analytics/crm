import { db } from "@crm/db";
import {
	reserveOutreachBudget,
	settleOutreachBudget,
} from "@crm/db/outreach-budget";
import { OUTREACH } from "@crm/validation/outreach";
import { DRAFTING } from "@crm/validation/outreach-drafts";
import { generateText } from "ai";
import { z } from "zod";

export const catalogSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			pricing: z.json().optional(),
		}),
	),
});
const tokenPrice = z.union([
	z.number().nonnegative(),
	z
		.string()
		.regex(/^\d+(?:\.\d+)?$/)
		.transform(Number)
		.pipe(z.number().nonnegative()),
]);
const textPriceSchema = z.object({
	input: tokenPrice,
	output: tokenPrice,
	varies_by_provider: z.boolean().optional(),
});
const costSchema = z.object({
	gateway: z.object({
		cost: z.union([
			z.number().nonnegative(),
			z
				.string()
				.regex(/^\d+(?:\.\d+)?$/)
				.transform(Number),
		]),
	}),
});
const fastReviewRouteSchema = z.object({
	gateway: z.object({
		routing: z.object({ speed: z.literal("fast") }),
		serviceTier: z.literal(DRAFTING.reviewServiceTier),
	}),
});
const rateLimitCodeSchema = z
	.enum(["rate_limit_exceeded", "insufficient_quota"])
	.optional()
	.catch(undefined);
const requestErrorFactSchema = z.object({
	name: z.enum(["AbortError", "TimeoutError", "other"]).catch("other"),
	statusCode: z.number().int().min(400).max(599).optional().catch(undefined),
	data: z
		.object({
			error: z.object({
				code: rateLimitCodeSchema,
				type: rateLimitCodeSchema,
			}),
		})
		.optional()
		.catch(undefined),
	responseHeaders: z
		.object({
			"retry-after": z
				.string()
				.trim()
				.regex(/^\d{1,4}$/)
				.transform(Number)
				.pipe(z.number().int().min(0).max(3600))
				.optional()
				.catch(undefined),
		})
		.optional()
		.catch(undefined),
});
const causedRequestErrorSchema = requestErrorFactSchema.extend({
	cause: requestErrorFactSchema.nullish().catch(null),
});
const requestErrorSchema = causedRequestErrorSchema.extend({
	lastError: causedRequestErrorSchema.nullish().catch(null),
});
export class OutreachAiError extends Error {}

function phaseModel(phase: TextRequest["phase"]) {
	return phase === "review" ? DRAFTING.reviewModel : DRAFTING.model;
}

export function catalogPrice(
	catalog: z.infer<typeof catalogSchema>,
	phase: TextRequest["phase"] = "generation",
) {
	const matches = catalog.data.filter(
		(model) => model.id === phaseModel(phase),
	);
	const price = textPriceSchema.safeParse(matches[0]?.pricing);
	if (matches.length !== 1 || !price.success || price.data.varies_by_provider)
		throw new OutreachAiError(
			"Selected AI model token pricing is unavailable or ambiguous. Drafts stay on hold.",
		);
	if (
		phase === "review" &&
		(price.data.input !== DRAFTING.reviewExpectedInputPrice ||
			price.data.output !== DRAFTING.reviewExpectedOutputPrice)
	)
		throw new OutreachAiError(
			"Fast review model pricing changed. Drafts stay held for cost review.",
		);
	return price.data;
}

type TextRequest = {
	phase: "generation" | "review" | "reply";
	instructions: string;
	prompt: string;
	maxOutputTokens: number;
};

export const gatewayText = {
	async generate(request: TextRequest) {
		const abortSignal = AbortSignal.timeout(OUTREACH.timeoutMs);
		try {
			const result = await generateText({
				instructions: request.instructions,
				prompt: request.prompt,
				maxOutputTokens: request.maxOutputTokens,
				model: phaseModel(request.phase),
				maxRetries: 0,
				abortSignal,
				providerOptions: {
					gateway:
						request.phase === "review"
							? { only: ["openai"], allowFallbackFromFast: false }
							: { only: ["openai"] },
					openai: {
						serviceTier:
							request.phase === "review"
								? DRAFTING.reviewServiceTier
								: "default",
						reasoningEffort: "low",
					},
				},
			});
			const step = await result.finalStep;
			const cost = costSchema.safeParse(step.providerMetadata);
			const response = {
				text: result.text,
				finishReason: result.finishReason,
				costMicroUsd: cost.success
					? Math.ceil(cost.data.gateway.cost * 1_000_000)
					: null,
			};
			return request.phase === "review"
				? {
						...response,
						reviewRouteVerified: fastReviewRouteSchema.safeParse(
							step.providerMetadata,
						).success,
					}
				: response;
		} catch (error) {
			const parsed = requestErrorSchema.safeParse(error);
			const facts = parsed.success
				? [
						parsed.data,
						parsed.data.cause,
						parsed.data.lastError,
						parsed.data.lastError?.cause,
					]
				: [];
			const status = facts.find((fact) => fact?.statusCode)?.statusCode;
			const rateLimitFacts = facts.filter((fact) => fact?.statusCode === 429);
			const code =
				rateLimitFacts
					.map((fact) => fact?.data?.error.code)
					.find((value) => value !== undefined) ??
				rateLimitFacts
					.map((fact) => fact?.data?.error.type)
					.find((value) => value !== undefined);
			const retryAfter = rateLimitFacts
				.map((fact) => fact?.responseHeaders?.["retry-after"])
				.find((value) => value !== undefined);
			const reason =
				abortSignal.aborted ||
				facts.some((fact) => fact?.name === "TimeoutError")
					? "timeout"
					: facts.some((fact) => fact?.name === "AbortError")
						? "aborted"
						: status
							? `HTTP ${status}`
							: "unclassified";
			const detail =
				reason === "HTTP 429"
					? `; code=${code ?? "unavailable"}; retry-after=${retryAfter === undefined ? "unavailable" : `${retryAfter}s`}`
					: "";
			throw new OutreachAiError(
				`AI ${request.phase} request failed (${reason}${detail}). Its reservation remains charged; no immediate retry occurs.`,
			);
		}
	},
};

export async function outreachAiText(request: TextRequest) {
	const campaign = await db.outreachCampaign.findUniqueOrThrow({
		where: { id: OUTREACH.id },
	});
	if (campaign.aiPausedReason)
		throw new OutreachAiError(campaign.aiPausedReason);
	const inputBytes = Buffer.byteLength(
		request.instructions + request.prompt,
		"utf8",
	);
	if (
		inputBytes > DRAFTING.maxInputBytes ||
		request.maxOutputTokens > DRAFTING.maxOutputTokens
	)
		throw new OutreachAiError(
			"AI request exceeds the bounded drafting allowance.",
		);
	let catalog: z.infer<typeof catalogSchema>;
	try {
		const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
			signal: AbortSignal.timeout(OUTREACH.timeoutMs),
		});
		if (!response.ok)
			throw new OutreachAiError(
				`AI model catalog returned HTTP ${response.status}. Drafts stay on hold.`,
			);
		catalog = catalogSchema.parse(await response.json());
	} catch (error) {
		if (error instanceof OutreachAiError) throw error;
		throw new OutreachAiError(
			"AI model pricing is unavailable. Drafts stay on hold.",
		);
	}
	const price = catalogPrice(catalog, request.phase);
	if (
		(price.input * (inputBytes + DRAFTING.inputOverheadTokens) +
			price.output * request.maxOutputTokens) *
			1_000_000 >
		OUTREACH.aiReserveMicroUsd
	)
		throw new OutreachAiError(
			"AI model price cannot fit the reserved drafting allowance.",
		);
	const budgetId = `ai:${new Date().toISOString().slice(0, 7)}`;
	if (
		!(await reserveOutreachBudget(
			db,
			budgetId,
			OUTREACH.aiReserveMicroUsd,
			OUTREACH.monthlyMicroUsd,
		))
	)
		throw new OutreachAiError(
			"The shared US$10 monthly CRM AI allowance is exhausted.",
		);
	const result = await gatewayText.generate(request);
	if (result.costMicroUsd !== null) {
		await settleOutreachBudget(
			db,
			budgetId,
			OUTREACH.aiReserveMicroUsd,
			result.costMicroUsd,
		);
		if (result.costMicroUsd > OUTREACH.aiReserveMicroUsd) {
			const reason =
				"AI cost exceeded its reservation. CRM AI drafting is paused for cost review.";
			await db.outreachCampaign.update({
				where: { id: OUTREACH.id },
				data: { aiPausedReason: reason },
			});
			throw new OutreachAiError(reason);
		}
	}
	if (
		request.phase === "review" &&
		!("reviewRouteVerified" in result && result.reviewRouteVerified === true)
	)
		throw new OutreachAiError(
			"Fast review delivery proof is missing or mismatched. Drafts stay held; no automatic retry occurs.",
		);
	const finishReason = z
		.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"])
		.safeParse(result.finishReason);
	if (!finishReason.success || finishReason.data !== "stop")
		throw new OutreachAiError(
			`AI ${request.phase} output did not finish normally (${finishReason.success ? finishReason.data : "unrecognized"}). Drafts stay held.`,
		);
	if (request.phase === "review")
		process.stderr.write(
			`${JSON.stringify({
				event: "outreach.fast_review_verified",
				model: DRAFTING.reviewModel,
				speed: "fast",
				serviceTier: DRAFTING.reviewServiceTier,
				costMicroUsd: result.costMicroUsd,
			})}\n`,
		);
	return result.text;
}

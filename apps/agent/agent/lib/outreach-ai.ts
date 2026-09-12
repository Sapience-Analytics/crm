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
const requestErrorFactSchema = z.object({
	name: z.enum(["AbortError", "TimeoutError", "other"]).catch("other"),
	statusCode: z.number().int().min(400).max(599).optional().catch(undefined),
});
const requestErrorSchema = requestErrorFactSchema.extend({
	cause: requestErrorFactSchema.nullish().catch(null),
	lastError: requestErrorFactSchema.nullish().catch(null),
});
export class OutreachAiError extends Error {}

export function catalogPrice(catalog: z.infer<typeof catalogSchema>) {
	const matches = catalog.data.filter((model) => model.id === DRAFTING.model);
	const price = textPriceSchema.safeParse(matches[0]?.pricing);
	if (matches.length !== 1 || !price.success || price.data.varies_by_provider)
		throw new OutreachAiError(
			"Selected AI model token pricing is unavailable or ambiguous. Drafts stay on hold.",
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
				model: DRAFTING.model,
				maxRetries: 0,
				abortSignal,
				providerOptions: {
					gateway: { only: ["openai"] },
					openai: { serviceTier: "default", reasoningEffort: "low" },
				},
			});
			const step = await result.finalStep;
			const cost = costSchema.safeParse(step.providerMetadata);
			return {
				text: result.text,
				finishReason: result.finishReason,
				costMicroUsd: cost.success
					? Math.ceil(cost.data.gateway.cost * 1_000_000)
					: null,
			};
		} catch (error) {
			const parsed = requestErrorSchema.safeParse(error);
			const facts = parsed.success
				? [parsed.data, parsed.data.cause, parsed.data.lastError]
				: [];
			const status = facts.find((fact) => fact?.statusCode)?.statusCode;
			const reason =
				abortSignal.aborted ||
				facts.some((fact) => fact?.name === "TimeoutError")
					? "timeout"
					: facts.some((fact) => fact?.name === "AbortError")
						? "aborted"
						: status
							? `HTTP ${status}`
							: "unclassified";
			throw new OutreachAiError(
				`AI ${request.phase} request failed (${reason}). Its reservation remains charged; no immediate retry occurs.`,
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
	const price = catalogPrice(catalog);
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
	const finishReason = z
		.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"])
		.safeParse(result.finishReason);
	if (!finishReason.success || finishReason.data !== "stop")
		throw new OutreachAiError(
			`AI ${request.phase} output did not finish normally (${finishReason.success ? finishReason.data : "unrecognized"}). Drafts stay held.`,
		);
	return result.text;
}

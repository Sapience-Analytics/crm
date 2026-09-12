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
			pricing: z
				.object({
					input: z.coerce.number().nonnegative(),
					output: z.coerce.number().nonnegative().optional(),
					varies_by_provider: z.boolean().optional(),
				})
				.optional(),
		}),
	),
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
export class OutreachAiError extends Error {}
type TextRequest = {
	instructions: string;
	prompt: string;
	maxOutputTokens: number;
};

export const gatewayText = {
	async generate(request: TextRequest) {
		try {
			const result = await generateText({
				instructions: request.instructions,
				prompt: request.prompt,
				maxOutputTokens: request.maxOutputTokens,
				model: DRAFTING.model,
				maxRetries: 0,
				abortSignal: AbortSignal.timeout(OUTREACH.timeoutMs),
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
		} catch {
			throw new OutreachAiError(
				"AI request failed. Its reservation remains charged; no immediate retry occurs.",
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
		if (!response.ok) throw new Error("price");
		catalog = catalogSchema.parse(await response.json());
	} catch {
		throw new OutreachAiError(
			"AI model pricing is unavailable. Drafts stay on hold.",
		);
	}
	const price = catalog.data.find(
		(model) => model.id === DRAFTING.model,
	)?.pricing;
	if (
		!price ||
		price.output === undefined ||
		price.varies_by_provider ||
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
	if (result.finishReason !== "stop")
		throw new OutreachAiError(
			"AI output did not finish normally or reached its output limit. Drafts stay held.",
		);
	return result.text;
}

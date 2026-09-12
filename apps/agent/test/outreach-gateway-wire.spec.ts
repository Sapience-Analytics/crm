import { afterEach, expect, test } from "bun:test";
import { DRAFTING } from "@crm/validation/outreach-drafts";
import { createGateway } from "ai";
import { z } from "zod";
import { gatewayText } from "../agent/lib/outreach-ai";

const originalProvider = globalThis.AI_SDK_DEFAULT_PROVIDER;
const wireSchema = z.object({
	maxOutputTokens: z.number(),
	prompt: z.array(
		z.discriminatedUnion("role", [
			z.object({ role: z.literal("system"), content: z.string() }),
			z.object({
				role: z.literal("user"),
				content: z.array(
					z.object({ type: z.literal("text"), text: z.string() }),
				),
			}),
		]),
	),
	providerOptions: z.object({
		gateway: z.object({ only: z.array(z.string()) }),
		openai: z.object({ serviceTier: z.string(), reasoningEffort: z.string() }),
	}),
});

afterEach(() => {
	globalThis.AI_SDK_DEFAULT_PROVIDER = originalProvider;
});

for (const phase of ["generation", "review", "reply"] as const)
	test(`the real SDK serializes all ${phase} instructions into the Gateway HTTP request`, async () => {
		const instructions = `${phase}: preserve the supplied instructions exactly. ${"Synthetic grounding and safety rule. ".repeat(100)}`;
		const prompt = JSON.stringify({
			company: "Synthetic Wire Test",
			verifiedSourceQuote: "We provide road transport services.",
		});
		const requests: Request[] = [];
		globalThis.AI_SDK_DEFAULT_PROVIDER = createGateway({
			apiKey: "synthetic-test-key-never-sent",
			fetch: async (url, init) => {
				const request = new Request(url, init);
				requests.push(request);
				return Response.json({
					content: [{ type: "text", text: "synthetic result" }],
					finishReason: { unified: "stop", raw: "stop" },
					usage: {
						inputTokens: {
							total: 1000,
							noCache: 1000,
							cacheRead: 0,
							cacheWrite: 0,
						},
						outputTokens: { total: 10, text: 10, reasoning: 0 },
					},
					providerMetadata: { gateway: { cost: "0.001" } },
				});
			},
		});
		const result = await gatewayText.generate({
			phase,
			instructions,
			prompt,
			maxOutputTokens: 3000,
		});
		expect(result).toEqual({
			text: "synthetic result",
			finishReason: "stop",
			costMicroUsd: 1000,
		});
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.method).toBe("POST");
		expect(new URL(request.url).pathname).toBe("/v4/ai/language-model");
		expect(request.headers.get("ai-language-model-id")).toBe(DRAFTING.model);
		const body = wireSchema.parse(await request.json());
		expect(body.prompt).toEqual([
			{ role: "system", content: instructions },
			{ role: "user", content: [{ type: "text", text: prompt }] },
		]);
		expect(body.maxOutputTokens).toBe(3000);
		expect(body.providerOptions).toEqual({
			gateway: { only: ["openai"] },
			openai: { serviceTier: "default", reasoningEffort: "low" },
		});
	});

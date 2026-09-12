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
		gateway: z.object({
			only: z.array(z.string()),
			allowFallbackFromFast: z.boolean().optional(),
		}),
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
					providerMetadata: {
						gateway: {
							cost: "0.001",
							routing: { speed: "fast" },
							serviceTier: "priority",
						},
					},
				});
			},
		});
		const result = await gatewayText.generate({
			phase,
			instructions,
			prompt,
			maxOutputTokens: 3000,
		});
		const expectedResult = {
			text: "synthetic result",
			finishReason: "stop",
			costMicroUsd: 1000,
		};
		expect(result).toEqual(
			phase === "review"
				? { ...expectedResult, reviewRouteVerified: true }
				: expectedResult,
		);
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.method).toBe("POST");
		expect(new URL(request.url).pathname).toBe("/v4/ai/language-model");
		expect(request.headers.get("ai-language-model-id")).toBe(
			phase === "review" ? DRAFTING.reviewModel : DRAFTING.model,
		);
		const body = wireSchema.parse(await request.json());
		expect(body.prompt).toEqual([
			{ role: "system", content: instructions },
			{ role: "user", content: [{ type: "text", text: prompt }] },
		]);
		expect(body.maxOutputTokens).toBe(3000);
		expect(body.providerOptions).toEqual({
			gateway:
				phase === "review"
					? { only: ["openai"], allowFallbackFromFast: false }
					: { only: ["openai"] },
			openai: {
				serviceTier: phase === "review" ? "priority" : "default",
				reasoningEffort: "low",
			},
		});
	});

for (const fixture of [
	{
		name: "Gateway rate limit",
		body: JSON.stringify({
			error: {
				message: "Private provider prose and Bearer synthetic-secret",
				type: "rate_limit_exceeded",
			},
		}),
		retryAfter: "120",
		detail: "code=rate_limit_exceeded; retry-after=120s",
	},
	{
		name: "upstream quota preserved behind the Gateway wrapper",
		body: JSON.stringify({
			error: {
				message: "Private provider prose and customer@example.test",
				type: "insufficient_quota",
				code: "insufficient_quota",
			},
		}),
		retryAfter: "3600",
		detail: "code=insufficient_quota; retry-after=3600s",
	},
	{
		name: "private unrecognized values",
		body: JSON.stringify({
			error: {
				message: "Private provider prose and customer@example.test",
				type: "Bearer synthetic-secret",
				code: "customer@example.test",
			},
		}),
		retryAfter: "Bearer synthetic-secret",
		detail: "code=unavailable; retry-after=unavailable",
	},
	{
		name: "malformed provider response",
		body: "<html>Private provider prose and customer@example.test</html>",
		retryAfter: "-1",
		detail: "code=unavailable; retry-after=unavailable",
	},
])
	test(`the real SDK retains only safe 429 facts: ${fixture.name}`, async () => {
		const requests: Request[] = [];
		globalThis.AI_SDK_DEFAULT_PROVIDER = createGateway({
			apiKey: "synthetic-test-key-never-sent",
			fetch: async (url, init) => {
				requests.push(new Request(url, init));
				return new Response(fixture.body, {
					status: 429,
					headers: {
						"content-type": "application/json",
						"Retry-After": fixture.retryAfter,
						"x-private-header": "Bearer synthetic-secret",
					},
				});
			},
		});
		const message = await gatewayText
			.generate({
				phase: "review",
				instructions: "Synthetic instructions never sent to a provider",
				prompt: "Synthetic prompt never sent to a provider",
				maxOutputTokens: DRAFTING.reviewOutputTokens,
			})
			.then(
				() => "unexpected success",
				(error) => error.message,
			);
		expect(message).toBe(
			`AI review request failed (HTTP 429; ${fixture.detail}). Its reservation remains charged; no immediate retry occurs.`,
		);
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.headers.get("ai-language-model-id")).toBe(
			DRAFTING.reviewModel,
		);
		const body = wireSchema.parse(await request.json());
		expect(body.maxOutputTokens).toBe(DRAFTING.reviewOutputTokens);
		expect(body.providerOptions).toEqual({
			gateway: { only: ["openai"], allowFallbackFromFast: false },
			openai: { serviceTier: "priority", reasoningEffort: "low" },
		});
	});

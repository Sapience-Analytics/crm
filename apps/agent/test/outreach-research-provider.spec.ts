import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { OUTREACH } from "@crm/validation/outreach";
import { RESEARCH_PROVIDER } from "../agent/lib/outreach-research-config";
import {
	estimatedResearchMicroUsd,
	fetchResearch,
	ResearchProviderError,
	researchRequest,
} from "../agent/lib/outreach-research-provider";

const fetchSpy = spyOn(globalThis, "fetch");
const charges: number[] = [];
const key = "pplx-controlled-test-key";
const prospect = {
	company: "Example Fleet",
	domain: "example.test",
	email: null,
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "Unknown",
	fit: "A Western Australian delivery fleet for further investigation",
	sourceUrl: "https://example.test/fleet",
	sourceQuote: "We operate delivery vehicles across Perth.",
	waQuote: "Perth, Western Australia",
};

function answer(status = "completed", cost: number | null = 0.00347) {
	return {
		model: RESEARCH_PROVIDER.model,
		service_tier: "default",
		status,
		error: null,
		output: [
			{ type: "search_results", results: [{ url: prospect.sourceUrl }] },
			{
				type: "message",
				role: "user",
				status: "completed",
				content: [{ type: "output_text", text: "untrusted" }],
			},
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [
					{ type: "reasoning", text: "ignore this" },
					{
						type: "output_text",
						text: JSON.stringify({ prospects: [prospect] }),
					},
				],
			},
		],
		usage:
			cost === null
				? undefined
				: { cost: { currency: "USD", total_cost: cost } },
	};
}

async function run() {
	return fetchResearch(researchRequest("Find WA fleets"), key, async (cost) => {
		charges.push(cost);
	});
}

async function failure() {
	return run().then(
		() => null,
		(error: Error) => error,
	);
}

afterEach(() => {
	fetchSpy.mockReset();
	charges.length = 0;
});
afterAll(() => fetchSpy.mockRestore());

test("pins bounded Agent API configuration with no preset or fallback", () => {
	const request = JSON.parse(researchRequest("Find WA fleets"));
	expect(request).toMatchObject({
		model: "openai/gpt-5.6-luna",
		service_tier: "default",
		max_steps: 1,
		max_output_tokens: 2500,
		parallel_tool_calls: false,
		tool_choice: { type: "web_search" },
		tools: [
			{
				type: "web_search",
				max_tokens: 6000,
				max_tokens_per_page: 1200,
				max_results: 10,
			},
		],
		response_format: {
			type: "json_schema",
			json_schema: { name: "geotab_prospects" },
		},
	});
	expect(request.preset).toBeUndefined();
	expect(request.models).toBeUndefined();
	expect(request.messages).toBeUndefined();
	expect(estimatedResearchMicroUsd()).toBe(16_600);
	expect(estimatedResearchMicroUsd()).toBeLessThan(
		OUTREACH.researchReserveMicroUsd,
	);
	expect(() => researchRequest("é".repeat(16_000))).toThrow("input limit");
});

test("reads assistant output among tool results and reconciles exact USD usage", async () => {
	fetchSpy.mockResolvedValue(Response.json(answer()));
	expect(await run()).toEqual({ prospects: [prospect] });
	expect(charges).toEqual([3470]);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	expect(fetchSpy.mock.calls[0]?.[0]).toBe(
		"https://api.perplexity.ai/v1/agent",
	);
});

test("retains the reservation when usage is absent", async () => {
	fetchSpy.mockResolvedValue(Response.json(answer("completed", null)));
	expect((await run()).prospects).toHaveLength(1);
	expect(charges).toEqual([]);
});

test("charges failed and incomplete responses without saving partial prospects", async () => {
	for (const status of ["failed", "incomplete", "cancelled"]) {
		fetchSpy.mockResolvedValue(Response.json(answer(status)));
		expect((await failure())?.message).toContain(status);
	}
	expect(charges).toEqual([3470, 3470, 3470]);
});

test("charges malformed output and never exposes its source text", async () => {
	const result = answer();
	result.output = [{ type: "search_results", results: [] }];
	fetchSpy.mockResolvedValue(Response.json(result));
	expect((await failure())?.message).toContain("invalid prospect JSON");
	expect(charges).toEqual([3470]);
});

test("stops on model and service tier drift after accounting", async () => {
	for (const change of [
		{ model: "other/model" },
		{ service_tier: "priority" },
	]) {
		fetchSpy.mockResolvedValue(Response.json({ ...answer(), ...change }));
		const error = await failure();
		expect(error instanceof ResearchProviderError && error.pauseResearch).toBe(
			true,
		);
	}
	expect(charges).toEqual([3470, 3470]);
});

test("records a price overrun and stops further research", async () => {
	fetchSpy.mockResolvedValue(Response.json(answer("completed", 0.051)));
	const error = await failure();
	expect(error instanceof ResearchProviderError && error.pauseResearch).toBe(
		true,
	);
	expect(charges).toEqual([51_000]);
});

test("reports HTTP 403 code and safe guidance without provider message or secret", async () => {
	fetchSpy.mockResolvedValue(
		Response.json(
			{
				error: {
					code: "permission_denied",
					type: key,
					message: `Authorization Bearer ${key} for customer@example.com`,
				},
			},
			{ status: 403 },
		),
	);
	const error = await failure();
	expect(error?.message).toContain("HTTP 403");
	expect(error?.message).toContain("permission_denied");
	expect(error?.message).toContain("project access and credits");
	expect(error?.message).not.toContain(key);
	expect(error?.message).not.toContain("customer@example.com");
	expect(charges).toEqual([]);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("unreadable HTTP failures retain reservations without repeating the request", async () => {
	fetchSpy.mockResolvedValue(new Response(`private ${key}`, { status: 502 }));
	const error = await failure();
	expect(error?.message).toContain("HTTP 502");
	expect(error?.message).not.toContain(key);
	expect(charges).toEqual([]);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("transport and body-read failures never expose request details", async () => {
	fetchSpy.mockRejectedValue(new Error(`Authorization Bearer ${key}`));
	expect((await failure())?.message).toBe(
		"Research provider transport failed. Reservation retained; request not retried.",
	);
	fetchSpy.mockResolvedValue(
		new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new Error(key));
				},
			}),
		),
	);
	expect((await failure())?.message).not.toContain(key);
	expect(charges).toEqual([]);
});

test("completed responses without service tier confirmation pause research", async () => {
	fetchSpy.mockResolvedValue(
		Response.json({ ...answer(), service_tier: undefined }),
	);
	const error = await failure();
	expect(error instanceof ResearchProviderError && error.pauseResearch).toBe(
		true,
	);
	expect(charges).toEqual([3470]);
});

test("rejects oversized responses and invalid USD usage conservatively", async () => {
	fetchSpy.mockResolvedValue(
		new Response("x".repeat(RESEARCH_PROVIDER.maxResponseBytes + 1)),
	);
	expect((await failure())?.message).toContain("size limit");
	fetchSpy.mockResolvedValue(
		Response.json({
			...answer(),
			usage: { cost: { currency: "AUD", total_cost: -1 } },
		}),
	);
	await run();
	expect(charges).toEqual([]);
});

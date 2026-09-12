import { expect, test } from "bun:test";
import { OUTREACH } from "@crm/validation/outreach";
import { DRAFTING } from "@crm/validation/outreach-drafts";
import { catalogPrice, catalogSchema } from "../agent/lib/outreach-ai";

const price = { input: "0.00000075", output: "0.0000045" };

test("valid selected text pricing survives unrelated image, video and embedding prices", () => {
	const catalog = catalogSchema.parse({
		data: [
			{ id: "bfl/flux-2-flex", pricing: {} },
			{
				id: "video-model",
				pricing: { video_duration_pricing: [{ duration: 5, price: "0.25" }] },
			},
			{ id: "embedding", pricing: { input: "0.0000001" } },
			{ id: "unrelated", pricing: { input: "non-token", output: null } },
			{ id: DRAFTING.model, pricing: price },
		],
	});
	expect(catalogPrice(catalog)).toEqual({
		input: 0.00000075,
		output: 0.0000045,
	});
});

test("catalog requires exactly one selected model with token prices", () => {
	for (const data of [
		[],
		[{ id: DRAFTING.model }],
		[{ id: DRAFTING.model, pricing: {} }],
		[{ id: DRAFTING.model, pricing: { input: price.input } }],
		[
			{ id: DRAFTING.model, pricing: price },
			{ id: DRAFTING.model, pricing: price },
		],
	]) {
		expect(() => catalogPrice(catalogSchema.parse({ data }))).toThrow(
			"pricing is unavailable or ambiguous",
		);
	}
});

test("null, blank, boolean, negative and malformed selected prices never become free tokens", () => {
	for (const invalid of [
		null,
		"",
		" ",
		true,
		false,
		-1,
		"-1",
		"NaN",
		"Infinity",
		"0.1 USD",
	]) {
		for (const field of ["input", "output"])
			expect(() =>
				catalogPrice(
					catalogSchema.parse({
						data: [
							{ id: DRAFTING.model, pricing: { ...price, [field]: invalid } },
						],
					}),
				),
			).toThrow("pricing is unavailable or ambiguous");
	}
});

test("varying provider pricing stays held and explicit numeric token prices are valid", () => {
	expect(() =>
		catalogPrice(
			catalogSchema.parse({
				data: [
					{
						id: DRAFTING.model,
						pricing: { ...price, varies_by_provider: true },
					},
				],
			}),
		),
	).toThrow("pricing is unavailable or ambiguous");
	expect(
		catalogPrice(
			catalogSchema.parse({
				data: [
					{
						id: DRAFTING.model,
						pricing: { input: 0.00000075, output: 0.0000045 },
					},
				],
			}),
		),
	).toEqual({ input: 0.00000075, output: 0.0000045 });
});

test("explicit zero prices remain valid numeric data rather than missing values", () => {
	expect(
		catalogPrice(
			catalogSchema.parse({
				data: [{ id: DRAFTING.model, pricing: { input: "0", output: 0 } }],
			}),
		),
	).toEqual({ input: 0, output: 0 });
});

test("review uses the fast catalog price while generation and replies retain the base price", () => {
	const catalog = catalogSchema.parse({
		data: [
			{ id: DRAFTING.model, pricing: price },
			{
				id: DRAFTING.reviewModel,
				pricing: { input: "0.0000015", output: "0.000009" },
			},
		],
	});
	for (const phase of ["generation", "reply"] as const)
		expect(catalogPrice(catalog, phase)).toEqual({
			input: 0.00000075,
			output: 0.0000045,
		});
	const reviewPrice = catalogPrice(catalog, "review");
	expect(reviewPrice).toEqual({ input: 0.0000015, output: 0.000009 });
	const boundMicroUsd =
		(reviewPrice.input *
			(DRAFTING.maxInputBytes + DRAFTING.inputOverheadTokens) +
			reviewPrice.output * DRAFTING.reviewOutputTokens) *
		1_000_000;
	expect(boundMicroUsd).toBeCloseTo(58_500, 6);
	expect(boundMicroUsd).toBeLessThan(OUTREACH.aiReserveMicroUsd);
	expect(OUTREACH.aiReserveMicroUsd).toBe(100_000);
	expect(OUTREACH.monthlyMicroUsd).toBe(10_000_000);
});

test("review never substitutes base prices for missing or ambiguous fast prices", () => {
	const selected = {
		id: DRAFTING.reviewModel,
		pricing: { input: "0.0000015", output: "0.000009" },
	};
	for (const fastEntries of [
		[],
		[{ id: DRAFTING.reviewModel }],
		[selected, selected],
		[
			{
				...selected,
				pricing: { ...selected.pricing, varies_by_provider: true },
			},
		],
	])
		expect(() =>
			catalogPrice(
				catalogSchema.parse({
					data: [{ id: DRAFTING.model, pricing: price }, ...fastEntries],
				}),
				"review",
			),
		).toThrow("pricing is unavailable or ambiguous");
});

test("fast price drift holds even when the changed price fits the reserve", () => {
	for (const changed of [
		{ input: "0.00000075", output: "0.0000045" },
		{ input: "0.0000016", output: "0.000009" },
		{ input: "0.0000015", output: "0.000008" },
		{ input: "0", output: "0" },
		{ input: "1", output: "1" },
	])
		expect(() =>
			catalogPrice(
				catalogSchema.parse({
					data: [{ id: DRAFTING.reviewModel, pricing: changed }],
				}),
				"review",
			),
		).toThrow("Fast review model pricing changed");
});

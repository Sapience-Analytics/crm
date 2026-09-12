import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as ai from "ai";
import { gatewayText } from "../agent/lib/outreach-ai";

const generate = spyOn(ai, "generateText");
const privateText =
	"Private provider prose, Bearer secret, customer@example.test";

afterEach(() => {
	generate.mockReset();
});
afterAll(() => {
	generate.mockRestore();
});

for (const phase of ["generation", "review", "reply"] as const)
	for (const statusCode of [401, 403, 429, 503])
		test(`${phase} errors expose only HTTP ${statusCode}`, async () => {
			generate.mockRejectedValue(
				Object.assign(new Error(privateText), {
					statusCode,
					responseBody: privateText,
					responseHeaders: { authorization: privateText },
				}),
			);
			const message = await gatewayText
				.generate({
					phase,
					instructions: "Test only",
					prompt: "Test only",
					maxOutputTokens: 10,
				})
				.then(
					() => "unexpected success",
					(error) => error.message,
				);
			expect(message).toBe(
				`AI ${phase} request failed (HTTP ${statusCode}${statusCode === 429 ? "; code=unavailable; retry-after=unavailable" : ""}). Its reservation remains charged; no immediate retry occurs.`,
			);
		});

for (const fixture of [
	{ error: new DOMException(privateText, "TimeoutError"), reason: "timeout" },
	{ error: new DOMException(privateText, "AbortError"), reason: "aborted" },
	{
		error: new Error(privateText, {
			cause: new DOMException(privateText, "TimeoutError"),
		}),
		reason: "timeout",
	},
	{
		error: Object.assign(new Error(privateText), {
			lastError: { statusCode: 502, message: privateText },
		}),
		reason: "HTTP 502",
	},
	{
		error: Object.assign(new Error(privateText), {
			statusCode: 99999,
			name: privateText,
		}),
		reason: "unclassified",
	},
	{
		error: Object.assign(new Error(privateText), {
			statusCode: "429",
			cause: privateText,
		}),
		reason: "unclassified",
	},
])
	test(`safe nested request diagnosis: ${fixture.reason}`, async () => {
		generate.mockRejectedValue(fixture.error);
		const message = await gatewayText
			.generate({
				phase: "review",
				instructions: "Test only",
				prompt: "Test only",
				maxOutputTokens: 10,
			})
			.then(
				() => "unexpected success",
				(error) => error.message,
			);
		expect(message).toBe(
			`AI review request failed (${fixture.reason}). Its reservation remains charged; no immediate retry occurs.`,
		);
	});

test("the actual request timeout signal identifies an opaque SDK failure", async () => {
	const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
		AbortSignal.abort(new DOMException(privateText, "TimeoutError")),
	);
	try {
		generate.mockRejectedValue(new Error(privateText));
		const message = await gatewayText
			.generate({
				phase: "generation",
				instructions: "Test only",
				prompt: "Test only",
				maxOutputTokens: 10,
			})
			.then(
				() => "unexpected success",
				(error) => error.message,
			);
		expect(message).toBe(
			"AI generation request failed (timeout). Its reservation remains charged; no immediate retry occurs.",
		);
	} finally {
		timeout.mockRestore();
	}
});

for (const retryAfter of ["0", "120", " 3600 "])
	test(`429 diagnostics permit bounded Retry-After ${retryAfter.trim()}`, async () => {
		generate.mockRejectedValue(
			Object.assign(new Error(privateText), {
				lastError: {
					statusCode: 429,
					type: "internal_server_error",
					cause: {
						statusCode: 429,
						data: {
							error: { code: "insufficient_quota", message: privateText },
						},
						responseHeaders: {
							"retry-after": retryAfter,
							authorization: privateText,
						},
					},
				},
			}),
		);
		const message = await gatewayText
			.generate({
				phase: "review",
				instructions: "Test only",
				prompt: "Test only",
				maxOutputTokens: 10,
			})
			.then(
				() => "unexpected success",
				(error) => error.message,
			);
		expect(message).toBe(
			`AI review request failed (HTTP 429; code=insufficient_quota; retry-after=${Number(retryAfter)}s). Its reservation remains charged; no immediate retry occurs.`,
		);
		expect(generate).toHaveBeenCalledTimes(1);
	});

for (const retryAfter of [
	"-1",
	"1.5",
	"Wed, 21 Oct 2015 07:28:00 GMT",
	"999999999999999999999",
	"",
	"1e3",
	"3601",
	privateText,
])
	test(`429 diagnostics discard invalid Retry-After fixture ${retryAfter.length}`, async () => {
		generate.mockRejectedValue({
			statusCode: 429,
			data: { error: { code: privateText, type: privateText } },
			responseHeaders: {
				"retry-after": retryAfter,
				authorization: privateText,
			},
			responseBody: privateText,
		});
		const message = await gatewayText
			.generate({
				phase: "generation",
				instructions: "Test only",
				prompt: "Test only",
				maxOutputTokens: 10,
			})
			.then(
				() => "unexpected success",
				(error) => error.message,
			);
		expect(message).toBe(
			"AI generation request failed (HTTP 429; code=unavailable; retry-after=unavailable). Its reservation remains charged; no immediate retry occurs.",
		);
	});

test("429 facts cannot come from a different nested HTTP status", async () => {
	generate.mockRejectedValue({
		statusCode: 429,
		cause: {
			statusCode: 402,
			data: { error: { code: "insufficient_quota" } },
			responseHeaders: { "retry-after": "120" },
		},
	});
	const message = await gatewayText
		.generate({
			phase: "review",
			instructions: "Test only",
			prompt: "Test only",
			maxOutputTokens: 10,
		})
		.then(
			() => "unexpected success",
			(error) => error.message,
		);
	expect(message).toBe(
		"AI review request failed (HTTP 429; code=unavailable; retry-after=unavailable). Its reservation remains charged; no immediate retry occurs.",
	);
});

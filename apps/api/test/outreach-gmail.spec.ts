import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { z } from "zod";
import { GmailClient } from "../src/google/gmail.client";
import { MailboxApiClient } from "../src/mailbox/mailbox-api.client";
import { OutreachGmail } from "../src/outreach/outreach-gmail";

const gmail = new OutreachGmail(new GmailClient(new MailboxApiClient()));
const now = new Date("2026-09-14T03:00:00.000Z");
const originalFetch = globalThis.fetch;
const requestSchema = z.object({
	url: z.string(),
	method: z.string(),
	headers: z.record(z.string(), z.string()),
	body: z.string(),
});
const requests: z.infer<typeof requestSchema>[] = [];
const restores: (() => void)[] = [];
const wireSchema = z.object({
	raw: z.string(),
	threadId: z.string().optional(),
});

function message(): Parameters<OutreachGmail["send"]>[1] {
	return {
		from: "sender@example.test",
		to: "controlled-recipient@example.test",
		subject: "Fleet review — a controlled test",
		body: "Hello,\n\nThis controlled test checks Unicode ✓ and MIME transport. ".repeat(
			4,
		),
		rfcId: "planned-stage-1@example.test",
	};
}

async function captured() {
	expect(requests).toHaveLength(1);
	const request = requests[0];
	if (!request) throw new Error("No captured Gmail request");
	const wire = wireSchema.parse(JSON.parse(request.body));
	const raw = Buffer.from(wire.raw, "base64url").toString("utf8");
	return { request, wire, raw };
}

beforeEach(() => {
	requests.length = 0;
	setSystemTime(now);
	const intercepted = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				requests.push(
					requestSchema.parse({
						url: input,
						...init,
						body: z.string().parse(init?.body),
					}),
				);
				return Response.json({
					id: "provider-message-1",
					threadId: "provider-thread-1",
				});
			},
			{ preconnect: originalFetch.preconnect },
		),
	);
	restores.push(() => intercepted.mockRestore());
});

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	setSystemTime();
});

describe("Gmail outreach MIME transport", () => {
	test("sends the planned ID, UTC Date, CRLF headers and Base64 MIME body", async () => {
		const input = message();
		expect(await gmail.send("synthetic-test-token", input)).toEqual({
			id: "provider-message-1",
			threadId: "provider-thread-1",
		});
		const { request, wire, raw } = await captured();
		expect(request.url).toBe(
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
		);
		expect(request.method).toBe("POST");
		expect(request.headers.authorization).toBe("Bearer synthetic-test-token");
		expect(request.headers["content-type"]).toBe("application/json");
		expect(wire.raw).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(wire.threadId).toBeUndefined();
		expect(raw.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
		const [headers, body] = raw.split("\r\n\r\n");
		expect(headers).toContain(`From: ${input.from}\r\n`);
		expect(headers).toContain(`To: ${input.to}\r\n`);
		expect(headers).toContain(
			`Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,
		);
		expect(headers).toContain(`Message-ID: <${input.rfcId}>`);
		expect(headers).toContain(`Date: ${now.toUTCString()}`);
		expect(headers).toContain("MIME-Version: 1.0");
		expect(headers).toContain("Content-Type: text/plain; charset=UTF-8");
		expect(headers).toContain("Content-Transfer-Encoding: base64");
		expect(headers).toContain(
			`List-Unsubscribe: <mailto:${input.from}?subject=unsubscribe>`,
		);
		expect(headers).not.toContain("In-Reply-To:");
		expect(headers).not.toContain("References:");
		expect(Buffer.from(body ?? "", "base64").toString("utf8")).toBe(input.body);
		for (const line of (body ?? "").split("\r\n")) {
			expect(line.length).toBeLessThanOrEqual(76);
			expect(line).toMatch(/^[A-Za-z0-9+/=]+$/);
		}
	});

	test("uses the observed root RFC ID and provider thread for a follow-up", async () => {
		const input = {
			...message(),
			rootId: "Observed.Root+Case@Mail.Gmail.com",
			threadId: "observed-provider-thread",
		};
		await gmail.send("synthetic-test-token", input);
		const { wire, raw } = await captured();
		expect(wire.threadId).toBe(input.threadId);
		expect(raw).toContain(`Message-ID: <${input.rfcId}>\r\n`);
		expect(raw).toContain(`In-Reply-To: <${input.rootId}>\r\n`);
		expect(raw).toContain(`References: <${input.rootId}>\r\n`);
		expect(raw).not.toContain(`References: <${input.rfcId}>`);
	});

	for (const field of ["from", "to", "subject", "rfcId", "rootId"] as const) {
		test(`rejects newline injection in ${field} before dispatch`, async () => {
			const input = {
				...message(),
				[field]: "value\r\nBcc: other@example.test",
			};
			await expect(gmail.send("synthetic-test-token", input)).rejects.toThrow(
				"Invalid email header",
			);
			expect(requests).toHaveLength(0);
		});
	}
});

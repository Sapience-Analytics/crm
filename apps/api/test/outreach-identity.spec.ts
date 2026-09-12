import { describe, expect, test } from "bun:test";
import { OUTREACH } from "@crm/validation/outreach";
import type { GmailMessage } from "../src/google/gmail.client";
import type { GmailHeader } from "../src/google/gmail-mime";
import { GmailSyncService } from "../src/google/gmail-sync.service";
import {
	type SentIdentity,
	verifiedSentIdentity,
} from "../src/outreach/outreach-identity";

const parser: GmailSyncService = Object.create(GmailSyncService.prototype);
const createdAt = new Date("2026-09-14T03:00:00.000Z");

function fixture() {
	const expected: SentIdentity = {
		gmailMessageId: "provider-message-1",
		gmailThreadId: "provider-thread-1",
		rfcMessageId: "planned-message@sapienceanalytics.com.au",
		observedRfcMessageId: null,
		sender: OUTREACH.sender,
		recipient: "controlled-recipient@example.test",
		subject: "Fleet review — vehicle visibility",
		body: "Hello,\n\nPlease reply with your fleet needs.\n\nDanny\nSapience Analytics",
		createdAt,
	};
	const message: GmailMessage = {
		id: expected.gmailMessageId ?? undefined,
		threadId: expected.gmailThreadId ?? undefined,
		labelIds: ["SENT"],
		internalDate: String(createdAt.getTime() + 1000),
		payload: {
			mimeType: "text/plain",
			headers: [
				{ name: "Message-ID", value: `<${expected.rfcMessageId}>` },
				{ name: "From", value: `Danny <${expected.sender}>` },
				{ name: "To", value: expected.recipient },
				{ name: "Subject", value: expected.subject },
				{ name: "Date", value: createdAt.toUTCString() },
			],
			body: { data: Buffer.from(expected.body).toString("base64url") },
		},
	};
	return { expected, message };
}

type Fixture = ReturnType<typeof fixture>;

function headersOf(value: Fixture): GmailHeader[] {
	const headers = value.message.payload?.headers;
	if (!headers) throw new Error("Fixture headers are missing");
	return headers;
}

function replaceHeader(value: Fixture, name: string, text: string) {
	const header = headersOf(value).find(
		(item) => item.name?.toLowerCase() === name.toLowerCase(),
	);
	if (!header) throw new Error("Fixture header is missing");
	header.value = text;
}

function replaceBody(value: Fixture, text: string) {
	if (!value.message.payload) throw new Error("Fixture payload is missing");
	value.message.payload.body = {
		data: Buffer.from(text).toString("base64url"),
	};
}

function verify(value: Fixture, requirePlannedId = false) {
	const parsed = parser.parse(value.message);
	if (!parsed) throw new Error("Gmail message cannot be parsed");
	return verifiedSentIdentity(
		value.message,
		parsed,
		value.expected,
		requirePlannedId,
	);
}

describe("verified Sent identity", () => {
	test("accepts the planned ID from an exact provider message", () => {
		const value = fixture();
		expect(verify(value, true)).toBe(value.expected.rfcMessageId);
	});

	test("records a provider-rewritten ID without changing the planned ID", () => {
		const value = fixture();
		const planned = value.expected.rfcMessageId;
		replaceHeader(value, "Message-ID", "<rewritten-observed@mail.gmail.com>");
		expect(verify(value)).toBe("rewritten-observed@mail.gmail.com");
		expect(value.expected.rfcMessageId).toBe(planned);
		expect(value.expected.observedRfcMessageId).toBeNull();
	});

	test("preserves the exact observed RFC casing for future References", () => {
		const value = fixture();
		replaceHeader(value, "Message-ID", "<Observed.Root+Case@Mail.Gmail.com>");
		expect(verify(value)).toBe("Observed.Root+Case@Mail.Gmail.com");
	});

	test("decodes a UTF-8 Base64 MIME subject", () => {
		const value = fixture();
		replaceHeader(
			value,
			"Subject",
			`=?UTF-8?B?${Buffer.from(value.expected.subject).toString("base64")}?=`,
		);
		expect(verify(value)).toBe(value.expected.rfcMessageId);
	});

	test("permits Gmail whitespace wrapping across the entire plain text body", () => {
		const value = fixture();
		replaceBody(
			value,
			`\r\n ${value.expected.body.replace(/\s+/g, " \r\n\t")}\r\n`,
		);
		expect(verify(value)).toBe(value.expected.rfcMessageId);
	});

	test("accepts the same observed ID on a later verification", () => {
		const value = fixture();
		value.expected.observedRfcMessageId = "observed@mail.gmail.com";
		replaceHeader(value, "Message-ID", "<observed@mail.gmail.com>");
		expect(verify(value)).toBe(value.expected.observedRfcMessageId);
	});

	test("unknown search requires the planned RFC ID", () => {
		const value = fixture();
		replaceHeader(value, "Message-ID", "<rewritten@mail.gmail.com>");
		expect(() => verify(value, true)).toThrow();
	});

	const invalid: { name: string; change: (value: Fixture) => void }[] = [
		{
			name: "different provider message",
			change: (value) => {
				value.message.id = "other-message";
			},
		},
		{
			name: "different provider thread",
			change: (value) => {
				value.message.threadId = "other-thread";
			},
		},
		{
			name: "missing provider message",
			change: (value) => {
				delete value.message.id;
			},
		},
		{
			name: "missing provider thread",
			change: (value) => {
				delete value.message.threadId;
			},
		},
		{
			name: "missing durable provider message",
			change: (value) => {
				value.expected.gmailMessageId = null;
			},
		},
		{
			name: "missing durable provider thread",
			change: (value) => {
				value.expected.gmailThreadId = null;
			},
		},
		{
			name: "message without SENT label",
			change: (value) => {
				value.message.labelIds = ["INBOX"];
			},
		},
		{
			name: "different sender",
			change: (value) => replaceHeader(value, "From", "other@example.test"),
		},
		{
			name: "multiple senders in one header",
			change: (value) =>
				replaceHeader(
					value,
					"From",
					`${value.expected.sender}, other@example.test`,
				),
		},
		{
			name: "duplicate From headers",
			change: (value) => {
				headersOf(value).push({ name: "fRoM", value: value.expected.sender });
			},
		},
		{
			name: "different recipient",
			change: (value) => replaceHeader(value, "To", "other@example.test"),
		},
		{
			name: "multiple recipients in one header",
			change: (value) =>
				replaceHeader(
					value,
					"To",
					`${value.expected.recipient}, other@example.test`,
				),
		},
		{
			name: "duplicate recipient within one header",
			change: (value) =>
				replaceHeader(
					value,
					"To",
					`${value.expected.recipient}, ${value.expected.recipient}`,
				),
		},
		{
			name: "duplicate To headers",
			change: (value) => {
				headersOf(value).push({ name: "tO", value: value.expected.recipient });
			},
		},
		{
			name: "CC recipient",
			change: (value) => {
				headersOf(value).push({ name: "Cc", value: "copy@example.test" });
			},
		},
		{
			name: "BCC recipient",
			change: (value) => {
				headersOf(value).push({ name: "Bcc", value: "hidden@example.test" });
			},
		},
		{
			name: "duplicate CC with an empty first header",
			change: (value) => {
				headersOf(value).push(
					{ name: "Cc", value: "" },
					{ name: "cC", value: "copy@example.test" },
				);
			},
		},
		{
			name: "duplicate BCC with an empty first header",
			change: (value) => {
				headersOf(value).push(
					{ name: "Bcc", value: "" },
					{ name: "bCC", value: "hidden@example.test" },
				);
			},
		},
		{
			name: "different subject",
			change: (value) => replaceHeader(value, "Subject", "Another subject"),
		},
		{
			name: "duplicate Subject headers",
			change: (value) => {
				headersOf(value).push({
					name: "Subject",
					value: value.expected.subject,
				});
			},
		},
		{
			name: "duplicate Message-ID headers",
			change: (value) => {
				headersOf(value).push({
					name: "Message-ID",
					value: `<${value.expected.rfcMessageId}>`,
				});
			},
		},
		{
			name: "invalid RFC ID",
			change: (value) => replaceHeader(value, "Message-ID", "<not-an-rfc-id>"),
		},
		{
			name: "reordered body tokens",
			change: (value) =>
				replaceBody(
					value,
					value.expected.body.replace("fleet needs", "needs fleet"),
				),
		},
		{
			name: "body with missing signature",
			change: (value) =>
				replaceBody(
					value,
					value.expected.body.replace("Sapience Analytics", ""),
				),
		},
		{
			name: "additional quoted body content",
			change: (value) =>
				replaceBody(
					value,
					`${value.expected.body}\n\nOn Monday, Someone wrote:\n> Unexpected extra text`,
				),
		},
		{
			name: "time before the accepted creation window",
			change: (value) => {
				value.message.internalDate = String(
					createdAt.getTime() - OUTREACH.minuteMs - 1,
				);
			},
		},
		{
			name: "time after the accepted creation window",
			change: (value) => {
				value.message.internalDate = String(
					createdAt.getTime() + OUTREACH.leaseMs + 1,
				);
			},
		},
		{
			name: "missing internalDate despite a valid Date header",
			change: (value) => {
				delete value.message.internalDate;
			},
		},
		{
			name: "invalid internalDate despite a valid Date header",
			change: (value) => {
				value.message.internalDate = "invalid-time";
			},
		},
		{
			name: "second conflicting observed RFC ID",
			change: (value) => {
				value.expected.observedRfcMessageId = "first-observed@mail.gmail.com";
				replaceHeader(value, "Message-ID", "<second-observed@mail.gmail.com>");
			},
		},
	];

	for (const { name, change } of invalid) {
		test(`rejects ${name}`, () => {
			const value = fixture();
			change(value);
			expect(() => verify(value)).toThrow();
		});
	}
});

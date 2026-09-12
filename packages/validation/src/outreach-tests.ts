import { z } from "zod";
import { OUTREACH } from "./outreach";

export const OUTREACH_TESTS = {
	kinds: ["reply", "optout"],
	dailyMessages: 2,
	maxHeaderBytes: 20_000,
	recentLimit: 10,
	contactName: "Controlled test inbox",
} as const;

export const launchTestKind = z.enum(OUTREACH_TESTS.kinds);
export const launchTestAuth = z.object({
	spf: z.boolean(),
	dkim: z.boolean(),
	dmarc: z.boolean(),
	messageId: z.string(),
	source: z.literal("owner-supplied-recipient-headers"),
});
export const startLaunchTestsInput = z.object({
	batchId: z.uuid(),
	recipientEmail: z
		.email()
		.trim()
		.toLowerCase()
		.refine(
			(email) => /@(gmail|googlemail)\.com$/.test(email),
			"Use a separate owner-controlled Gmail inbox for receiver authentication checks.",
		),
	ownsMailbox: z.literal(true),
	acceptsTwoEmails: z.literal(true),
});
export const launchTestIdInput = z.object({ id: z.string().min(1) });
export const launchTestHeadersInput = launchTestIdInput.extend({
	headers: z.string().min(30).max(OUTREACH_TESTS.maxHeaderBytes),
});
export const launchTestsOutput = z.object({
	rows: z.array(
		z.object({
			id: z.string(),
			batchId: z.string(),
			kind: launchTestKind,
			recipientEmail: z.string(),
			subject: z.string(),
			body: z.string(),
			status: z.string(),
			rfcMessageId: z.string(),
			gmailMessageId: z.string().nullable(),
			gmailThreadId: z.string().nullable(),
			loggedAt: z.string().nullable(),
			responseStatus: z.string().nullable(),
			responseAt: z.string().nullable(),
			responseLoggedAt: z.string().nullable(),
			recipientAuth: launchTestAuth.nullable(),
			lastError: z.string().nullable(),
			createdAt: z.string(),
		}),
	),
});

export function launchTestContent(kind: z.infer<typeof launchTestKind>) {
	const reply = kind === "reply";
	return {
		subject: `Sapience CRM controlled ${reply ? "reply" : "opt-out"} test`,
		body: `This is a controlled setup test for Danny's Sapience Analytics CRM. It is not a sales email.\n\nPlease reply: ${reply ? "Test reply received." : "Unsubscribe this test."}\n\nThis test sends no automatic follow-ups.\n\nDanny\nSapience Analytics\ndanny@sapienceanalytics.com.au\nhttps://sapienceanalytics.com.au`,
	};
}

export function recipientHeaderEvidence(
	raw: string,
	rfcMessageId: string,
	recipientEmail: string,
) {
	const unfolded = (raw.split(/\r?\n\r?\n/)[0] ?? "").replace(
		/\r?\n[ \t]+/g,
		" ",
	);
	const messageId = unfolded.match(/^message-id:\s*<([^>]+)>/im)?.[1];
	if (messageId !== rfcMessageId)
		throw new Error("Recipient headers must match this test Message-ID.");
	const from = unfolded.match(/^from:\s*(.+)$/im)?.[1]?.toLowerCase() ?? "";
	const recipients = [...unfolded.matchAll(/^(?:delivered-to|to):\s*(.+)$/gim)]
		.map((match) => match[1])
		.join(" ")
		.toLowerCase();
	const addresses = (text: string): string[] =>
		text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) ?? [];
	if (
		!addresses(from).includes(OUTREACH.sender) ||
		!addresses(recipients).includes(recipientEmail.toLowerCase())
	)
		throw new Error(
			"Recipient headers must show the test sender and controlled recipient.",
		);
	const auth = unfolded.match(
		/^authentication-results:\s*(mx\.google\.com\s*;.+)$/im,
	)?.[1];
	if (!auth)
		throw new Error(
			"Recipient Authentication-Results from mx.google.com are required. Copy Show original from the receiving Gmail inbox.",
		);
	const senderDomain = OUTREACH.sender.split("@")[1];
	const clauses = auth.split(";");
	const aligned = (method: string, fields: string[]) =>
		clauses.some((clause) => {
			if (!new RegExp(`\\b${method}=pass\\b`, "i").test(clause)) return false;
			return fields.some((field) => {
				const value = clause
					.match(
						new RegExp(`\\b${field.replaceAll(".", "\\.")}=([^\\s;]+)`, "i"),
					)?.[1]
					?.replaceAll('"', "")
					.toLowerCase();
				return value?.split("@").pop() === senderDomain;
			});
		});
	return launchTestAuth.parse({
		spf: aligned("spf", ["smtp.mailfrom"]),
		dkim: aligned("dkim", ["header.d", "header.i"]),
		dmarc: aligned("dmarc", ["header.from"]),
		messageId,
		source: "owner-supplied-recipient-headers",
	});
}

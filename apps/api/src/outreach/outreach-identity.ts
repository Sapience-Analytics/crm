import { OUTREACH } from "@crm/validation/outreach";
import { z } from "zod";
import type { GmailMessage } from "../google/gmail.client";
import { header, plainTextBody } from "../google/gmail-mime";
import { normaliseMessageId } from "../mailbox/message-text";
import { parseAddressList } from "../mailbox/participants";
import type { IncomingMessage } from "../mailbox/thread-writer.service";

const rfcIdSchema = z.string().regex(/^[^<>\s@]+@[^<>\s@]+$/);
const internalDateSchema = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int().positive());
const singleMailboxSchema = z
	.string()
	.regex(
		/^(?:(?:"[^"]*"|[^<>,@"]*)\s*<[^<>,\s]+@[^<>,\s]+>|[^<>,\s]+@[^<>,\s]+)$/,
	);

export type SentIdentity = {
	gmailMessageId: string | null;
	gmailThreadId: string | null;
	rfcMessageId: string;
	observedRfcMessageId: string | null;
	sender: string;
	recipient: string;
	subject: string;
	body: string;
	createdAt: Date;
};

function subjectText(value: string | null) {
	return (
		value
			?.replace(/\?=\s+(?==\?)/g, "?=")
			.replace(/=\?utf-8\?b\?([a-z0-9+/=]+)\?=/gi, (_match, encoded: string) =>
				Buffer.from(encoded, "base64").toString("utf8"),
			) ?? ""
	);
}

function bodyText(value: string) {
	return value.replace(/\s+/g, " ").trim();
}

export function verifiedSentIdentity(
	message: GmailMessage,
	parsed: IncomingMessage,
	expected: SentIdentity,
	requirePlannedId = false,
) {
	const rawId = header(message.payload?.headers, "message-id");
	const observed = rfcIdSchema.safeParse(
		rawId?.trim().replace(/^</, "").replace(/>$/, ""),
	);
	if (!observed.success)
		throw new Error("Sent message has no valid RFC Message-ID.");
	if (
		!singleMailboxSchema.safeParse(header(message.payload?.headers, "from"))
			.success ||
		!singleMailboxSchema.safeParse(header(message.payload?.headers, "to"))
			.success ||
		!expected.gmailMessageId ||
		!expected.gmailThreadId ||
		message.id !== expected.gmailMessageId ||
		message.threadId !== expected.gmailThreadId ||
		!message.labelIds?.includes("SENT")
	)
		throw new Error("Sent message does not match its durable Gmail identity.");
	if (
		parseAddressList(header(message.payload?.headers, "from")).length !== 1 ||
		parsed.from.email.toLowerCase() !== expected.sender.toLowerCase() ||
		parsed.recipients.length !== 1 ||
		parsed.recipients[0]?.kind !== "to" ||
		parsed.recipients[0]?.email.toLowerCase() !==
			expected.recipient.toLowerCase() ||
		message.payload?.headers?.some((item) =>
			["cc", "bcc"].includes(item.name?.toLowerCase() ?? ""),
		)
	)
		throw new Error(
			"Sent message participants do not match its durable record.",
		);
	for (const name of ["message-id", "from", "to", "subject"])
		if (
			message.payload?.headers?.filter(
				(item) => item.name?.toLowerCase() === name,
			).length !== 1
		)
			throw new Error("Sent message has ambiguous identity headers.");
	if (
		subjectText(parsed.subject) !== expected.subject ||
		bodyText(plainTextBody(message.payload)) !== bodyText(expected.body)
	)
		throw new Error("Sent message content does not match its durable record.");
	const internalDate = internalDateSchema.safeParse(message.internalDate);
	if (!internalDate.success)
		throw new Error("Sent message provider timestamp is unavailable.");
	const elapsed = internalDate.data - expected.createdAt.getTime();
	if (
		!Number.isFinite(elapsed) ||
		elapsed < -OUTREACH.minuteMs ||
		elapsed > OUTREACH.leaseMs
	)
		throw new Error("Sent message time does not match its durable record.");
	if (
		(expected.observedRfcMessageId &&
			observed.data !== expected.observedRfcMessageId) ||
		(requirePlannedId &&
			normaliseMessageId(observed.data) !==
				normaliseMessageId(expected.rfcMessageId))
	)
		throw new Error(
			"Sent message RFC identity changed or cannot be reconciled.",
		);
	return observed.data;
}

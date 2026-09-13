import { OUTREACH } from "@crm/validation/outreach";
import { incomingReferralSchema } from "@crm/validation/outreach-referrals";
import { z } from "zod";
import type { GmailMessage } from "../google/gmail.client";
import { header } from "../google/gmail-mime";
import { parseAddressList } from "../mailbox/participants";

const providerDateSchema = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int().positive());

export function captureOutreachInbound(
	message: GmailMessage,
	body: string,
	threadIds: ReadonlySet<string>,
) {
	const headers = message.payload?.headers ?? [];
	const from = parseAddressList(header(headers, "from"));
	const date = providerDateSchema.safeParse(message.internalDate);
	if (
		from.length !== 1 ||
		headers.filter((entry) => entry.name?.toLowerCase() === "from").length !==
			1 ||
		!date.success ||
		date.data > Date.now() + OUTREACH.minuteMs ||
		!Number.isFinite(new Date(date.data).getTime())
	)
		return null;
	const sender = from[0]?.email;
	const authentication = headers.filter(
		(entry) => entry.name?.toLowerCase() === "authentication-results",
	);
	const result =
		authentication.length === 1 ? (authentication[0]?.value ?? "") : "";
	const dmarc = result
		.split(";")
		.find((part) => /^\s*dmarc=pass\b/i.test(part));
	const authDomain = dmarc
		?.match(/\bheader\.from=([a-z0-9.-]+)(?:\s|;|$)/i)?.[1]
		?.toLowerCase();
	const parsed = incomingReferralSchema.safeParse({
		messageId: message.id,
		threadId: message.threadId,
		fromEmail: sender,
		toEmails: [
			...new Set(
				[
					...parseAddressList(header(headers, "to")),
					...parseAddressList(header(headers, "cc")),
				].map((entry) => entry.email),
			),
		],
		rfcMessageId: header(headers, "message-id"),
		receivedAt: new Date(date.data).toISOString(),
		body,
		authenticated:
			/^\s*mx\.google\.com\s*;/i.test(result) &&
			Boolean(authDomain) &&
			authDomain === sender?.split("@")[1] &&
			!message.labelIds?.some((label) =>
				["SENT", "DRAFT", "SPAM", "TRASH"].includes(label),
			),
		inCampaignThread: Boolean(
			message.threadId && threadIds.has(message.threadId),
		),
	});
	return parsed.success ? parsed.data : null;
}

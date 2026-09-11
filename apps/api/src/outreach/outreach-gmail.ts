import { OUTREACH } from "@crm/validation/outreach";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { GmailClient, type GmailMessage } from "../google/gmail.client";

const listSchema = z.object({
	messages: z
		.array(z.object({ id: z.string(), threadId: z.string() }))
		.default([]),
	nextPageToken: z.string().optional(),
});
const sentSchema = z.object({ id: z.string(), threadId: z.string() });
const base = "https://gmail.googleapis.com/gmail/v1/users/me";

@Injectable()
export class OutreachGmail {
	constructor(private readonly gmail: GmailClient) {}

	async search(token: string, query: string) {
		const url = new URL(`${base}/messages`);
		url.searchParams.set("q", query);
		url.searchParams.set("maxResults", "100");
		url.searchParams.set("includeSpamTrash", "true");
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(OUTREACH.timeoutMs),
		});
		if (!response.ok)
			throw new Error(
				`Gmail search failed (${response.status}). Sending is held.`,
			);
		const result = listSchema.parse(await response.json());
		if (result.nextPageToken)
			throw new Error(
				"Mailbox search requires more than 100 results. Sending is held.",
			);
		return result.messages;
	}

	async message(token: string, id: string): Promise<GmailMessage> {
		const result = await this.gmail.getMessage(token, id);
		if (result.outcome !== "ok")
			throw new Error("Gmail message could not be read. Sending is held.");
		return result.data;
	}

	async threadIds(token: string, id: string) {
		const response = await fetch(
			`${base}/threads/${encodeURIComponent(id)}?format=minimal`,
			{
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(OUTREACH.timeoutMs),
			},
		);
		if (!response.ok)
			throw new Error("Gmail thread could not be checked. Sending is held.");
		return z
			.object({ messages: z.array(z.object({ id: z.string() })) })
			.parse(await response.json()).messages;
	}

	async profile(token: string) {
		const result = await this.gmail.profile(token);
		if (result.outcome !== "ok" || !result.data.emailAddress)
			throw new Error("Gmail identity check failed.");
		return result.data.emailAddress.toLowerCase();
	}

	async send(
		token: string,
		message: {
			to: string;
			from: string;
			subject: string;
			body: string;
			rfcId: string;
			rootId?: string;
			threadId?: string;
		},
	) {
		for (const value of [
			message.to,
			message.from,
			message.subject,
			message.rfcId,
			message.rootId ?? "",
		]) {
			if (/[\r\n]/.test(value)) throw new Error("Invalid email header");
		}
		const lines = [
			`From: ${message.from}`,
			`To: ${message.to}`,
			`Subject: =?UTF-8?B?${Buffer.from(message.subject).toString("base64")}?=`,
			`Message-ID: <${message.rfcId}>`,
			`Date: ${new Date().toUTCString()}`,
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: base64",
			`List-Unsubscribe: <mailto:${message.from}?subject=unsubscribe>`,
			...(message.rootId
				? [
						`In-Reply-To: <${message.rootId}>`,
						`References: <${message.rootId}>`,
					]
				: []),
			"",
			Buffer.from(message.body)
				.toString("base64")
				.match(/.{1,76}/g)
				?.join("\r\n") ?? "",
		];
		const response = await fetch(`${base}/messages/send`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				raw: Buffer.from(lines.join("\r\n")).toString("base64url"),
				threadId: message.threadId,
			}),
			signal: AbortSignal.timeout(OUTREACH.timeoutMs),
		});
		if (!response.ok)
			throw new Error(
				`Gmail send returned ${response.status}. Reconciliation is required.`,
			);
		return sentSchema.parse(await response.json());
	}
}

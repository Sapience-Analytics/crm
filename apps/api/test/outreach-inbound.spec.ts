import { describe, expect, test } from "bun:test";
import type { GmailMessage } from "../src/google/gmail.client";
import { captureOutreachInbound } from "../src/outreach/outreach-inbound";

function message(): GmailMessage {
	return {
		id: "mail-1",
		threadId: "thread-1",
		internalDate: String(Date.now()),
		labelIds: ["INBOX"],
		payload: {
			headers: [
				{ name: "From", value: "Operations <operations@example.com>" },
				{ name: "To", value: "Danny <danny@sapienceanalytics.com.au>" },
				{ name: "Message-ID", value: "<referral@example.com>" },
				{
					name: "Authentication-Results",
					value:
						"mx.google.com; dkim=pass header.i=@example.com; dmarc=pass (p=REJECT) header.from=example.com",
				},
			],
		},
	};
}

describe("inbound referral provenance", () => {
	test("captures the exact sender, provider identity and approved thread", () => {
		expect(
			captureOutreachInbound(
				message(),
				"Please email Alex at alex@example.com",
				new Set(["thread-1"]),
			),
		).toMatchObject({
			messageId: "mail-1",
			fromEmail: "operations@example.com",
			toEmails: ["danny@sapienceanalytics.com.au"],
			authenticated: true,
			inCampaignThread: true,
		});
	});
	for (const authentication of [
		"other.example; dmarc=pass header.from=example.com",
		"mx.google.com; dmarc=fail header.from=example.com",
		"mx.google.com; dmarc=pass header.from=attacker.example",
		"mx.google.com; arc=pass; spf=pass smtp.mailfrom=example.com",
	])
		test(`does not trust ${authentication}`, () => {
			const row = message();
			row.payload?.headers?.splice(3, 1, {
				name: "Authentication-Results",
				value: authentication,
			});
			expect(
				captureOutreachInbound(row, "Please email Alex", new Set(["thread-1"]))
					?.authenticated,
			).toBe(false);
		});
	test("duplicate authentication headers never establish trust", () => {
		const row = message();
		row.payload?.headers?.push({
			name: "Authentication-Results",
			value: "mx.google.com; dmarc=pass header.from=example.com",
		});
		expect(
			captureOutreachInbound(row, "Please email Alex", new Set(["thread-1"]))
				?.authenticated,
		).toBe(false);
	});
	test("duplicate From headers reject the capture", () => {
		const row = message();
		row.payload?.headers?.push({ name: "From", value: "other@example.com" });
		expect(
			captureOutreachInbound(row, "Please email Alex", new Set(["thread-1"])),
		).toBeNull();
	});
	test("a new thread does not become an existing campaign conversation", () => {
		expect(
			captureOutreachInbound(message(), "Please email Alex", new Set())
				?.inCampaignThread,
		).toBe(false);
	});
	for (const label of ["SENT", "DRAFT", "SPAM", "TRASH"])
		test(`${label} cannot authorise a referral`, () => {
			const row = message();
			row.labelIds = [label];
			expect(
				captureOutreachInbound(row, "Please email Alex", new Set(["thread-1"]))
					?.authenticated,
			).toBe(false);
		});
	test("missing and future provider timestamps reject the capture", () => {
		const row = message();
		delete row.internalDate;
		expect(
			captureOutreachInbound(row, "Please email Alex", new Set(["thread-1"])),
		).toBeNull();
		row.internalDate = String(Date.now() + 86_400_000);
		expect(
			captureOutreachInbound(row, "Please email Alex", new Set(["thread-1"])),
		).toBeNull();
	});
});

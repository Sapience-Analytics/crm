import { describe, expect, test } from "bun:test";
import {
	launchTestContent,
	recipientHeaderEvidence,
	startLaunchTestsInput,
} from "../src/outreach-tests";

describe("controlled outreach tests", () => {
	const senderHeaders =
		"From: Danny <danny@sapienceanalytics.com.au>\r\nTo: owner@gmail.com\r\n";
	test("requires explicit mailbox ownership and two-message confirmation", () => {
		expect(
			startLaunchTestsInput.safeParse({
				batchId: crypto.randomUUID(),
				recipientEmail: "test@example.test",
			}).success,
		).toBe(false);
		expect(launchTestContent("reply").body).toContain("Test reply received.");
		expect(launchTestContent("optout").body).toContain(
			"Unsubscribe this test.",
		);
	});
	test("requires receiver authentication headers for the exact test message", () => {
		const raw = `${senderHeaders}Message-ID: <test@sapienceanalytics.com.au>\r\nAuthentication-Results: mx.google.com;\r\n spf=pass smtp.mailfrom=danny@sapienceanalytics.com.au; dkim=pass header.i=@sapienceanalytics.com.au; dmarc=pass header.from=sapienceanalytics.com.au\r\n`;
		expect(
			recipientHeaderEvidence(
				raw,
				"test@sapienceanalytics.com.au",
				"owner@gmail.com",
			),
		).toEqual({
			spf: true,
			dkim: true,
			dmarc: true,
			messageId: "test@sapienceanalytics.com.au",
			source: "owner-supplied-recipient-headers",
		});
		expect(() =>
			recipientHeaderEvidence(raw, "different@test", "owner@gmail.com"),
		).toThrow("Message-ID");
		expect(() =>
			recipientHeaderEvidence(
				`${senderHeaders}Message-ID: <test@sapienceanalytics.com.au>`,
				"test@sapienceanalytics.com.au",
				"owner@gmail.com",
			),
		).toThrow("Authentication-Results");
		expect(() =>
			recipientHeaderEvidence(
				raw,
				"test@sapienceanalytics.com.au",
				"other@gmail.com",
			),
		).toThrow("controlled recipient");
	});
	test("records failed receiver authentication without marking it passed", () => {
		const raw = `${senderHeaders}Message-ID: <test@sapienceanalytics.com.au>\nAuthentication-Results: mx.google.com; spf=fail; dkim=none; dmarc=fail\n`;
		expect(
			recipientHeaderEvidence(
				raw,
				"test@sapienceanalytics.com.au",
				"owner@gmail.com",
			).dmarc,
		).toBe(false);
	});
	test("rejects unrelated domains, mixed receiver results and body header injection", () => {
		const raw = `${senderHeaders}Message-ID: <test@sapienceanalytics.com.au>\nAuthentication-Results: mx.google.com; spf=pass smtp.mailfrom=sender@other.test; dkim=pass header.d=other.test; dmarc=fail header.from=sapienceanalytics.com.au\nAuthentication-Results: mx.google.com; dmarc=pass header.from=sapienceanalytics.com.au\n\nAuthentication-Results: mx.google.com; spf=pass smtp.mailfrom=danny@sapienceanalytics.com.au\n`;
		const result = recipientHeaderEvidence(
			raw,
			"test@sapienceanalytics.com.au",
			"owner@gmail.com",
		);
		expect(result.spf).toBe(false);
		expect(result.dkim).toBe(false);
		expect(result.dmarc).toBe(false);
	});
});

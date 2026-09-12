import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "@crm/db";
import { evidenceSchema } from "@crm/validation/outreach";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import {
	type IncomingMessage,
	ThreadWriterService,
} from "../src/mailbox/thread-writer.service";
import { verifiedOutreachContact } from "../src/outreach/outreach-contact";
import { storeOutreachMessage } from "../src/outreach/outreach-message";

const userId = `outreach-contact-test-${crypto.randomUUID()}`;
const ownerEmail = `${userId}@owner.example.test`;
let created = false;

beforeAll(async () => {
	await db.user.create({
		data: {
			id: userId,
			name: "Contact binding test",
			email: ownerEmail,
			emailVerified: true,
		},
	});
	created = true;
});

afterAll(async () => {
	if (created) {
		await db.emailThread.deleteMany({
			where: { messages: { some: { syncedByUserId: userId } } },
		});
		await db.contact.deleteMany({ where: { ownerId: userId } });
		await db.company.deleteMany({ where: { ownerId: userId } });
		await db.user.delete({ where: { id: userId } });
	}
	await db.$disconnect();
});

async function fixture() {
	const id = crypto.randomUUID();
	const domain = `${id}.example.test`;
	const email = `operations@parent-${id}.example.test`;
	const company = await db.company.create({
		data: { name: "Verified branch", domain, ownerId: userId },
	});
	const contact = await db.contact.create({
		data: { firstName: email, email, companyId: company.id, ownerId: userId },
	});
	return {
		companyId: company.id,
		contactId: contact.id,
		domain,
		email,
		evidence: evidenceSchema.parse({
			company: company.name,
			domain,
			email,
			industry: "transport",
			fleetBand: "unknown",
			fleetEvidence: "unknown",
			fit: "Verified branch publishes its parent-domain operations contact.",
			sourceUrl: `https://${domain}/contact`,
			sourceQuote: "We operate a road fleet for local deliveries.",
			waQuote: "Perth",
			checkedAt: new Date().toISOString(),
			verified: true,
		}),
	};
}

async function rejectionMessage(request: Promise<unknown>) {
	return request.then(
		() => "UNEXPECTED_SUCCESS",
		(error: Error) => error.message,
	);
}

describe("verified campaign contact binding", () => {
	test("accepts a published parent-domain address without changing its company", async () => {
		const prospect = await fixture();
		expect(await verifiedOutreachContact(db, prospect, userId)).toBe(
			prospect.contactId,
		);
		expect(
			await db.company.count({
				where: { domain: prospect.email.split("@")[1] },
			}),
		).toBe(0);
	});

	test("rejects missing or changed durable evidence and foreign contact ownership", async () => {
		const prospect = await fixture();
		for (const change of [
			{ contactId: null },
			{ companyId: null },
			{ email: "different@recipient.example.test" },
			{ domain: "different.example.test" },
			{ evidence: { ...prospect.evidence, verified: false } },
		]) {
			expect(
				await rejectionMessage(
					verifiedOutreachContact(db, { ...prospect, ...change }, userId),
				),
			).toContain("contact");
		}
		expect(
			await rejectionMessage(
				verifiedOutreachContact(db, prospect, "different-owner"),
			),
		).toContain("contact");
	});

	test("rejects archived contacts and changed company association", async () => {
		const prospect = await fixture();
		await db.contact.update({
			where: { id: prospect.contactId },
			data: { archivedAt: new Date() },
		});
		expect(
			await rejectionMessage(verifiedOutreachContact(db, prospect, userId)),
		).toContain("contact");
		await db.contact.update({
			where: { id: prospect.contactId },
			data: { archivedAt: null, companyId: null },
		});
		expect(
			await rejectionMessage(verifiedOutreachContact(db, prospect, userId)),
		).toContain("contact");
	});

	test("rejects archived companies and changed company domains", async () => {
		const prospect = await fixture();
		await db.company.update({
			where: { id: prospect.companyId },
			data: { archivedAt: new Date() },
		});
		expect(
			await rejectionMessage(verifiedOutreachContact(db, prospect, userId)),
		).toContain("contact");
		await db.company.update({
			where: { id: prospect.companyId },
			data: { archivedAt: null, domain: `changed-${prospect.domain}` },
		});
		expect(
			await rejectionMessage(verifiedOutreachContact(db, prospect, userId)),
		).toContain("contact");
	});

	test("rejects company ownership changes after verification", async () => {
		const prospect = await fixture();
		await db.company.update({
			where: { id: prospect.companyId },
			data: { ownerId: null },
		});
		try {
			expect(
				await rejectionMessage(verifiedOutreachContact(db, prospect, userId)),
			).toContain("contact");
		} finally {
			await db.company.update({
				where: { id: prospect.companyId },
				data: { ownerId: userId },
			});
		}
	});

	test("logs sent mail and its reply under the verified company and contact", async () => {
		const prospect = await fixture();
		const contactId = await verifiedOutreachContact(db, prospect, userId);
		const mailbox = await db.mailboxSync.upsert({
			where: { userId_source: { userId, source: "gmail" } },
			create: { userId, source: "gmail" },
			update: {},
		});
		const context = {
			ourAddresses: new Set([ownerEmail]),
			ourDomains: new Set<string>(),
			suppressedDomains: new Set<string>(),
			suppressedEmails: new Set<string>(),
		};
		const match: MailboxMatchService = Object.create(
			MailboxMatchService.prototype,
		);
		const writer = new ThreadWriterService(
			db,
			match,
			new ActivityStampService(db),
		);
		writer.context = async () => context;
		const rootId = `outreach-contact-${crypto.randomUUID()}@example.test`;
		const outgoing: IncomingMessage = {
			rfcMessageId: rootId,
			rootId,
			subject: "Fleet needs",
			from: { email: ownerEmail, name: null },
			recipients: [{ email: prospect.email, name: null, kind: "to" }],
			body: "A controlled fixture with no external delivery.",
			sentAt: new Date(),
		};
		await storeOutreachMessage(
			db,
			writer,
			mailbox,
			ownerEmail,
			outgoing,
			contactId,
		);
		await writer.store(
			mailbox,
			{ mailbox: ownerEmail, origin: "gmail" },
			{
				...outgoing,
				rfcMessageId: `reply-${rootId}`,
				from: { email: prospect.email, name: null },
				recipients: [{ email: ownerEmail, name: null, kind: "to" }],
				body: "Please discuss fleet reporting.",
			},
			context,
		);
		const thread = await db.emailThread.findUniqueOrThrow({
			where: { rootMessageId: rootId },
			include: { activity: true },
		});
		expect(thread).toMatchObject({
			contactId,
			companyId: prospect.companyId,
			messageCount: 2,
		});
		expect(thread.activity).toMatchObject({
			contactId,
			companyId: prospect.companyId,
		});
		await db.emailThread.update({
			where: { id: thread.id },
			data: { contactId: null },
		});
		expect(
			await rejectionMessage(
				storeOutreachMessage(
					db,
					writer,
					mailbox,
					ownerEmail,
					outgoing,
					contactId,
				),
			),
		).toContain("do not match");
	});
});

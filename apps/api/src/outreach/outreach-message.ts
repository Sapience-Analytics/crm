import type { Db, MailboxSyncModel } from "@crm/db";
import { stopReason } from "@crm/validation/outreach";
import type { GmailMessage } from "../google/gmail.client";
import { header, plainTextBody } from "../google/gmail-mime";
import { stripQuotedHistory } from "../mailbox/message-text";
import type {
	IncomingMessage,
	ThreadWriterService,
} from "../mailbox/thread-writer.service";

export function classifyOutreachMessage(message: GmailMessage) {
	const body = stripQuotedHistory(plainTextBody(message.payload));
	const from = header(message.payload?.headers, "from") ?? "";
	const subject = header(message.payload?.headers, "subject") ?? "";
	return { status: stopReason(from, `${subject}\n${body}`), body };
}

export async function storeOutreachMessage(
	db: Db,
	writer: ThreadWriterService,
	mailbox: MailboxSyncModel,
	sender: string,
	parsed: IncomingMessage,
	knownContactId?: string,
) {
	await writer.store(
		mailbox,
		{ mailbox: sender, origin: "gmail" },
		parsed,
		await writer.context(),
		knownContactId,
	);
	const logged = await db.emailMessage.findUnique({
		where: { rfcMessageId: parsed.rfcMessageId },
		select: {
			id: true,
			thread: {
				select: {
					contactId: true,
					companyId: true,
					activity: { select: { id: true, contactId: true, companyId: true } },
				},
			},
		},
	});
	if (!logged?.thread.activity)
		throw new Error(
			"Sent email has no CRM message and activity. Logging will retry.",
		);
	if (knownContactId) {
		const contact = await db.contact.findUnique({
			where: { id: knownContactId },
			select: { companyId: true },
		});
		if (
			!contact ||
			logged.thread.contactId !== knownContactId ||
			logged.thread.companyId !== contact.companyId ||
			logged.thread.activity.contactId !== knownContactId ||
			logged.thread.activity.companyId !== contact.companyId
		)
			throw new Error(
				"The CRM message and activity do not match the verified outreach contact.",
			);
	}
	return logged.id;
}

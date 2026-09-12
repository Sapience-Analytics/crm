import type { Db, OutreachProspectModel } from "@crm/db";
import { evidenceSchema } from "@crm/validation/outreach";

export async function verifiedOutreachContact(
	db: Pick<Db, "contact">,
	prospect: Pick<
		OutreachProspectModel,
		"companyId" | "contactId" | "domain" | "email" | "evidence"
	>,
	ownerId: string,
) {
	const evidence = evidenceSchema.safeParse(prospect.evidence);
	if (
		!prospect.companyId ||
		!prospect.contactId ||
		!prospect.email ||
		!evidence.success ||
		!evidence.data.verified ||
		evidence.data.domain !== prospect.domain ||
		evidence.data.email !== prospect.email
	)
		throw new Error(
			"A verified company and contact binding is required before outreach.",
		);
	const contact = await db.contact.findUnique({
		where: { id: prospect.contactId },
		select: {
			id: true,
			email: true,
			companyId: true,
			ownerId: true,
			archivedAt: true,
			company: { select: { domain: true, archivedAt: true, ownerId: true } },
		},
	});
	if (
		!contact ||
		contact.email !== prospect.email ||
		contact.companyId !== prospect.companyId ||
		contact.ownerId !== ownerId ||
		contact.archivedAt ||
		!contact.company ||
		contact.company.ownerId !== ownerId ||
		contact.company.archivedAt ||
		contact.company.domain !== prospect.domain
	)
		throw new Error(
			"The outreach contact no longer matches its verified company, recipient and owner.",
		);
	return contact.id;
}

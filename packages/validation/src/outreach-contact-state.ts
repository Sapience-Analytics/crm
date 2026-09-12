import { createHash } from "node:crypto";
import type { OutreachProspectModel } from "@crm/db";
import { evidenceSchema } from "./outreach";
import { CONTACT_RESEARCH } from "./outreach-contacts";

export function contactResearchInputHash(
	prospect: Pick<OutreachProspectModel, "domain" | "email" | "evidence">,
) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: CONTACT_RESEARCH.version,
				domain: prospect.domain,
				email: prospect.email,
				evidence: evidenceSchema.parse(prospect.evidence),
			}),
		)
		.digest("hex");
}

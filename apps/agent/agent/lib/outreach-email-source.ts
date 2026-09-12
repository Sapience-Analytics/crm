import { evidenceSchema } from "@crm/validation/outreach";
import { OUTREACH_INTAKE } from "@crm/validation/outreach-intake";

export function decodeCloudflareEmail(value: string) {
	if (
		value.length < 4 ||
		value.length > OUTREACH_INTAKE.maxObfuscatedEmailChars ||
		!/^(?:[a-f0-9]{2})+$/i.test(value)
	)
		return null;
	const bytes = Buffer.from(value, "hex");
	const key = bytes[0];
	if (key === undefined) return null;
	const decoded = Buffer.from(
		bytes.subarray(1).map((byte) => byte ^ key),
	).toString("utf8");
	const email = evidenceSchema.shape.email.safeParse(decoded);
	return email.success ? email.data : null;
}

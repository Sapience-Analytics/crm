import type { Db } from "./client";

export async function reserveOutreachBudget(
	db: Db,
	id: string,
	amount: number,
	limit: number,
): Promise<boolean> {
	if (
		!Number.isSafeInteger(amount) ||
		amount <= 0 ||
		!Number.isSafeInteger(limit) ||
		limit < amount
	)
		return false;
	const rows = await db.$queryRaw<{ id: string }[]>`
		INSERT INTO "outreachBudget" (id, "reservedMicroUsd", "actualMicroUsd", calls, "updatedAt")
		VALUES (${id}, ${amount}, 0, 1, ${new Date()})
		ON CONFLICT (id) DO UPDATE SET
			"reservedMicroUsd" = "outreachBudget"."reservedMicroUsd" + ${amount},
			calls = "outreachBudget".calls + 1,
			"updatedAt" = ${new Date()}
		WHERE "outreachBudget"."reservedMicroUsd" <= ${limit - amount}
		RETURNING id
	`;
	return rows.length === 1;
}

export async function settleOutreachBudget(
	db: Db,
	id: string,
	reserved: number,
	actual: number,
) {
	if (!Number.isSafeInteger(actual) || actual < 0)
		throw new Error("Invalid provider cost");
	await db.outreachBudget.update({
		where: { id },
		data: {
			reservedMicroUsd: { increment: actual - reserved },
			actualMicroUsd: { increment: actual },
		},
	});
}

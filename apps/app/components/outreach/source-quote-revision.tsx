"use client";

import { Button } from "@crm/ui/components/button";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@crm/ui/components/field";
import { Textarea } from "@crm/ui/components/textarea";
import { reviseSourceQuoteInput } from "@crm/validation/outreach-intake";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";

export function SourceQuoteRevision({
	id,
	company,
	sourceQuote,
	sourceUrl,
}: {
	id: string;
	company: string;
	sourceQuote: string;
	sourceUrl: string;
}) {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const [quote, setQuote] = useState(sourceQuote);
	const parsed = reviseSourceQuoteInput.safeParse({ id, sourceQuote: quote });
	const revise = useMutation(
		trpc.outreachIntake.reviseSourceQuote.mutationOptions({
			onSuccess: async () => {
				await cache.outreach();
				toast.success(
					"Source quote saved. Verification is queued and sending is paused.",
				);
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const fieldId = `source-quote-${id}`;
	return (
		<details>
			<summary>Revise source quote for {company}</summary>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (parsed.success) revise.mutate(parsed.data);
				}}
			>
				<FieldGroup>
					<Field
						data-invalid={!parsed.success}
						data-disabled={revise.isPending}
					>
						<FieldLabel htmlFor={fieldId}>
							Source quote for {company}
						</FieldLabel>
						<FieldDescription>
							Copy an exact excerpt from the{" "}
							<a href={sourceUrl} target="_blank" rel="noreferrer">
								existing company source
							</a>
							.
						</FieldDescription>
						<Textarea
							id={fieldId}
							value={quote}
							rows={5}
							maxLength={600}
							disabled={revise.isPending}
							aria-invalid={!parsed.success}
							onChange={(event) => setQuote(event.target.value)}
						/>
						{!parsed.success && (
							<FieldError>
								Enter an exact source quote of 20–600 characters.
							</FieldError>
						)}
					</Field>
					<p>
						Saving pauses campaign sending and rechecks the source. It clears
						this prospect’s draft previews and recorded review. Manual and pilot
						assignments stay the same.
					</p>
					<Button
						type="submit"
						variant="outline"
						disabled={revise.isPending || !parsed.success}
					>
						{revise.isPending
							? "Queuing source check…"
							: "Save quote and recheck"}
					</Button>
				</FieldGroup>
			</form>
		</details>
	);
}

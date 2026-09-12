"use client";

import { Alert, AlertDescription, AlertTitle } from "@crm/ui/components/alert";
import { Button } from "@crm/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@crm/ui/components/card";
import { Checkbox } from "@crm/ui/components/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@crm/ui/components/empty";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@crm/ui/components/field";
import { Input } from "@crm/ui/components/input";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Textarea } from "@crm/ui/components/textarea";
import {
	launchTestContent,
	OUTREACH_TESTS,
} from "@crm/validation/outreach-tests";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";

type LaunchTest = RouterOutputs["outreach"]["launchTests"]["rows"][number];

export function ControlledTests({ sendConnected }: { sendConnected: boolean }) {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const [recipientEmail, setRecipientEmail] = useState("");
	const [ownsMailbox, setOwnsMailbox] = useState(false);
	const [acceptsTwoEmails, setAcceptsTwoEmails] = useState(false);
	const batchId = useRef<string | null>(null);
	const tests = useQuery(trpc.outreach.launchTests.queryOptions());
	const start = useMutation(
		trpc.outreach.startLaunchTests.mutationOptions({
			onSuccess: () => {
				setAcceptsTwoEmails(false);
				toast.success("Test batch recorded. Check the results below.");
				return cache.outreach();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	return (
		<div className="flex flex-col gap-4">
			<Card>
				<CardHeader>
					<CardTitle>Controlled Gmail tests</CardTitle>
					<CardDescription>
						Send two fixed test emails to an external Gmail inbox you own. Only
						the campaign owner can run these tests.
					</CardDescription>
				</CardHeader>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (
							!sendConnected ||
							!ownsMailbox ||
							!acceptsTwoEmails ||
							start.isPending
						)
							return;
						batchId.current ??= crypto.randomUUID();
						start.mutate({
							batchId: batchId.current,
							recipientEmail: recipientEmail.trim(),
							ownsMailbox: true,
							acceptsTwoEmails: true,
						});
					}}
				>
					<CardContent>
						<FieldGroup>
							<Alert>
								<AlertTitle>Separate from prospect outreach</AlertTitle>
								<AlertDescription>
									Tests use no pilot slots and send no follow-ups. Sending to
									the business mailbox itself cannot verify external delivery or
									incoming replies. A separate contact named “Controlled test
									inbox” records these messages. Tests check reply and opt-out
									detection; they do not run a prospect sequence.
								</AlertDescription>
							</Alert>
							<Field data-disabled={start.isPending}>
								<FieldLabel htmlFor="test-recipient">
									External Gmail inbox you own
								</FieldLabel>
								<Input
									id="test-recipient"
									type="email"
									required
									autoComplete="off"
									placeholder="you@gmail.com"
									value={recipientEmail}
									disabled={start.isPending}
									onChange={(event) => {
										setRecipientEmail(event.target.value);
										setOwnsMailbox(false);
										setAcceptsTwoEmails(false);
										batchId.current = null;
									}}
								/>
								<FieldDescription>
									Use a separate Gmail mailbox where you can read headers and
									reply. The authentication check reads Google's recipient
									headers. Existing contacts, prospects and business-domain
									addresses cannot receive these tests.
								</FieldDescription>
							</Field>
							<details>
								<summary>Preview both fixed test messages</summary>
								{OUTREACH_TESTS.kinds.map((kind) => {
									const message = launchTestContent(kind);
									return (
										<div key={kind}>
											<p>{message.subject}</p>
											<pre className="whitespace-pre-wrap">{message.body}</pre>
										</div>
									);
								})}
							</details>
							<FieldSet disabled={start.isPending}>
								<FieldLegend variant="label">
									Confirm this test batch
								</FieldLegend>
								<FieldGroup>
									<Field
										orientation="horizontal"
										data-disabled={start.isPending}
									>
										<Checkbox
											id="test-mailbox-owner"
											checked={ownsMailbox}
											disabled={start.isPending}
											onCheckedChange={(checked) =>
												setOwnsMailbox(checked === true)
											}
										/>
										<FieldLabel htmlFor="test-mailbox-owner">
											I own and control this external Gmail inbox.
										</FieldLabel>
									</Field>
									<Field
										orientation="horizontal"
										data-disabled={start.isPending}
									>
										<Checkbox
											id="test-email-consent"
											checked={acceptsTwoEmails}
											disabled={start.isPending}
											onCheckedChange={(checked) =>
												setAcceptsTwoEmails(checked === true)
											}
										/>
										<FieldLabel htmlFor="test-email-consent">
											Send exactly these two test emails to this inbox.
										</FieldLabel>
									</Field>
								</FieldGroup>
							</FieldSet>
							{!sendConnected && (
								<Alert>
									<AlertTitle>Gmail sending permission is required</AlertTitle>
									<AlertDescription>
										Use Connect Gmail sending above before starting a test.
									</AlertDescription>
								</Alert>
							)}
						</FieldGroup>
					</CardContent>
					<CardFooter>
						<Button
							type="submit"
							disabled={
								!sendConnected ||
								!recipientEmail.trim() ||
								!ownsMailbox ||
								!acceptsTwoEmails ||
								start.isPending
							}
						>
							{start.isPending
								? "Starting test batch…"
								: "Send two controlled test emails"}
						</Button>
					</CardFooter>
				</form>
			</Card>
			{tests.error && (
				<Alert variant="destructive">
					<AlertTitle>Test results are unavailable</AlertTitle>
					<AlertDescription>{tests.error.message}</AlertDescription>
				</Alert>
			)}
			{tests.isPending && <Skeleton className="h-20 w-full" />}
			{tests.data?.rows.length === 0 && (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>No controlled tests yet</EmptyTitle>
						<EmptyDescription>
							Test results and recipient header evidence appear here.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}
			{tests.data?.rows.map((test) => (
				<TestResult key={test.id} test={test} />
			))}
		</div>
	);
}

function TestResult({ test }: { test: LaunchTest }) {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const [headers, setHeaders] = useState("");
	const options = {
		onSuccess: () => cache.outreach(),
		onError: (error: { message: string }) => toast.error(error.message),
	};
	const check = useMutation(
		trpc.outreach.checkLaunchTest.mutationOptions(options),
	);
	const record = useMutation(
		trpc.outreach.recordLaunchTestHeaders.mutationOptions({
			...options,
			onSuccess: () => {
				setHeaders("");
				return cache.outreach();
			},
		}),
	);
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					{test.kind === "reply" ? "Reply test" : "Opt-out test"}: {test.status}
				</CardTitle>
				<CardDescription>
					{test.recipientEmail} · {test.createdAt}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<FieldGroup>
					<div>
						<p>
							Sent message logged in CRM: {test.loggedAt ?? "Not confirmed"}
						</p>
						<p>Incoming response: {test.responseStatus ?? "Not detected"}</p>
						<p>Response received: {test.responseAt ?? "Not confirmed"}</p>
						<p>
							Response logged in CRM: {test.responseLoggedAt ?? "Not confirmed"}
						</p>
					</div>
					{test.lastError && (
						<Alert variant="destructive">
							<AlertTitle>Test needs attention</AlertTitle>
							<AlertDescription>{test.lastError}</AlertDescription>
						</Alert>
					)}
					<details>
						<summary>Test message and evidence references</summary>
						<p>{test.subject}</p>
						<pre className="whitespace-pre-wrap">{test.body}</pre>
						<p>Test: {test.id}</p>
						<p>Batch: {test.batchId}</p>
						<p>Planned Message-ID: {test.rfcMessageId}</p>
						<p>
							Delivered Message-ID:{" "}
							{test.observedRfcMessageId ?? "Not verified"}
						</p>
						<p>Gmail message: {test.gmailMessageId ?? "Not confirmed"}</p>
						<p>Gmail thread: {test.gmailThreadId ?? "Not confirmed"}</p>
					</details>
					<p>
						Open this test email in your external Gmail inbox. Reply with “
						{test.kind === "reply"
							? "Test reply received."
							: "Unsubscribe this test."}
						”. Then check the results.
					</p>
					<Button
						variant="outline"
						disabled={check.isPending}
						onClick={() => check.mutate({ id: test.id })}
					>
						{check.isPending ? "Checking results…" : "Check results"}
					</Button>
					<details>
						<summary>Recipient header evidence</summary>
						<FieldGroup>
							<Field data-disabled={record.isPending}>
								<FieldLabel htmlFor={`${test.id}-headers`}>
									Full headers from the received test email
								</FieldLabel>
								<FieldDescription>
									In the receiving Gmail inbox, open Show original and copy the
									full headers from this test email. Only paste headers for this
									test.
								</FieldDescription>
								<Textarea
									id={`${test.id}-headers`}
									rows={6}
									maxLength={OUTREACH_TESTS.maxHeaderBytes}
									value={headers}
									disabled={record.isPending}
									onChange={(event) => setHeaders(event.target.value)}
								/>
							</Field>
							<Button
								variant="outline"
								disabled={record.isPending || headers.trim().length < 30}
								onClick={() => record.mutate({ id: test.id, headers })}
							>
								{record.isPending
									? "Recording headers…"
									: "Record recipient header evidence"}
							</Button>
						</FieldGroup>
					</details>
					{test.recipientAuth ? (
						<div>
							<p>Evidence source: owner-supplied recipient headers.</p>
							<p>
								SPF: {test.recipientAuth.spf ? "Pass" : "Not passed"} · DKIM:{" "}
								{test.recipientAuth.dkim ? "Pass" : "Not passed"} · DMARC:{" "}
								{test.recipientAuth.dmarc ? "Pass" : "Not passed"}
							</p>
							<p>Header Message-ID: {test.recipientAuth.messageId}</p>
						</div>
					) : (
						<p>Recipient authentication evidence: not recorded.</p>
					)}
				</FieldGroup>
			</CardContent>
			<CardFooter>
				<p>These results do not approve launch checks or enable outreach.</p>
			</CardFooter>
		</Card>
	);
}

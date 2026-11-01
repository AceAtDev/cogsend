import { buildMessage, formatAddress, type OutgoingMail } from './mime';
import { sendSmtp, SmtpError, type SmtpConnect, type SmtpFailure } from './smtp';

export const GMAIL_SMTP_HOST = 'smtp.gmail.com';

/** Hands one finished email to whoever delivers it. Throws a SendError. */
export interface MailTransport {
	send(mail: OutgoingMail): Promise<void>;
}

export type SendFailure = SmtpFailure | 'provider' | 'config';

/** A failed send, with a message written for the person in Settings. */
export class SendError extends Error {
	constructor(
		readonly kind: SendFailure,
		message: string
	) {
		super(message);
		this.name = 'SendError';
	}
}

/**
 * What to tell the user. Gmail's own reply text is kept (it names the exact
 * reason and links its help page), with the step that will fix it in front.
 */
export function describeSmtpError(err: SmtpError, host: string, port: number): SendError {
	const where = `${host}:${port}`;
	const reply = err.reply ? `${err.reply.code} ${err.reply.lines.join(' ')}`.trim() : err.message;
	switch (err.kind) {
		case 'connect':
			return new SendError(
				'connect',
				`Could not connect to ${where}: the connection was refused or dropped (${err.message}). Cloudflare may be blocking this port from Workers; try port ${port === 465 ? 587 : 465}, or send through Resend instead.`
			);
		case 'tls':
			return new SendError('tls', `The secure (TLS) connection to ${where} failed: ${err.message}`);
		case 'timeout':
			return new SendError('timeout', `${where} stopped answering: ${err.message}`);
		case 'auth':
			// 534 5.7.9 is Gmail asking for an app password instead of the account's own.
			if (err.reply?.code === 534 || /5\.7\.9/.test(reply)) {
				return new SendError(
					'auth',
					`Gmail wants an app password, not the Google account password (${reply}). Turn on 2-Step Verification and create one at myaccount.google.com/apppasswords.`
				);
			}
			return new SendError(
				'auth',
				`Gmail did not accept the address and app password (${reply}). Check the address, and paste a fresh 16-letter app password.`
			);
		case 'rejected':
			return new SendError('rejected', `Gmail refused the message: ${err.message}`);
		default:
			return new SendError('protocol', `Unexpected answer from ${where}: ${err.message}`);
	}
}

export function gmailTransport(opts: {
	connect: SmtpConnect;
	address: string;
	appPassword: string;
	port: number;
	clientName?: string;
	timeoutMs?: number;
}): MailTransport {
	return {
		async send(mail) {
			try {
				await sendSmtp({
					connect: opts.connect,
					host: GMAIL_SMTP_HOST,
					port: opts.port,
					security: opts.port === 587 ? 'starttls' : 'tls',
					username: opts.address,
					password: opts.appPassword,
					from: mail.from.email,
					to: mail.to.map((r) => r.email),
					message: buildMessage(mail),
					clientName: opts.clientName,
					timeoutMs: opts.timeoutMs
				});
			} catch (err) {
				if (err instanceof SmtpError) throw describeSmtpError(err, GMAIL_SMTP_HOST, opts.port);
				throw new SendError(
					'connect',
					`Sending through ${GMAIL_SMTP_HOST}:${opts.port} failed: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	};
}

/** The instance's Resend account, as the failure digest and sign-up use it. */
export function resendTransport(opts: { apiKey: string; fetchImpl?: typeof fetch }): MailTransport {
	return {
		async send(mail) {
			const send = opts.fetchImpl ?? fetch;
			let res: Response;
			try {
				res = await send('https://api.resend.com/emails', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${opts.apiKey}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						// NOTIFY_FROM may already be `Name <address>`: passed as it is.
						from: mail.from.name ? formatAddress(mail.from) : mail.from.email,
						to: mail.to.map((r) => r.email),
						subject: mail.subject,
						text: mail.text,
						html: mail.html
					})
				});
			} catch (err) {
				throw new SendError(
					'connect',
					`Could not reach Resend: ${err instanceof Error ? err.message : String(err)}`
				);
			}
			if (!res.ok) {
				const detail = (await res.text().catch(() => '')).slice(0, 200);
				throw new SendError(
					res.status === 401 || res.status === 403 ? 'auth' : 'provider',
					`Resend refused the email (${res.status})${detail ? `: ${detail}` : ''}`
				);
			}
		}
	};
}

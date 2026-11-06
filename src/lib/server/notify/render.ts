import type { MailBlock, MailLine } from './events';

/** Plain text and a simple inline-styled HTML version of the same blocks. */

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Only http(s) links reach an href: a stored remote URL is not ours to trust. */
function safeHref(href: string | undefined): string | null {
	if (!href) return null;
	try {
		const url = new URL(href);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
	} catch {
		return null;
	}
}

const BADGE_COLORS: Record<NonNullable<MailLine['badge']>['tone'], [string, string]> = {
	success: ['#dcfce7', '#166534'],
	warn: ['#fef3c7', '#92400e'],
	error: ['#fee2e2', '#991b1b']
};

/**
 * One line as a card: thumbnail on the left; badge, heading, text, note and
 * link stacked on the right. Tables, because mail apps ignore most CSS layout.
 */
function cardHtml(line: MailLine, compact = false): string {
	if (compact) line = compactLine(line);
	const href = safeHref(line.href);
	const image = safeHref(line.image);
	const size = compact ? 48 : 64;
	const thumb = image
		? `<img src="${escapeHtml(image)}" width="${size}" height="${size}" alt="" style="display:block;width:${size}px;height:${size}px;object-fit:cover;border-radius:8px;background:#f5f5f4">`
		: `<div style="width:${size}px;height:${size}px;border-radius:8px;background:#f5f5f4;color:#a8a29e;font-size:11px;line-height:${size}px;text-align:center">Text</div>`;
	const [bg, fg] = line.badge ? BADGE_COLORS[line.badge.tone] : ['', ''];
	const badge = line.badge
		? `<span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:700;letter-spacing:0.02em;padding:2px 8px;border-radius:999px">${escapeHtml(line.badge.text)}</span>`
		: '';
	const detailColor = line.tone === 'error' ? '#b91c1c' : '#78716c';
	const parts = [
		badge,
		`<div style="font-weight:700;font-size:14px;margin-top:${badge ? 4 : 0}px">${escapeHtml(line.title ?? '')}</div>`,
		`<div style="color:#44403c;font-size:13px">${escapeHtml(line.text)}</div>`,
		line.detail
			? `<div style="color:${detailColor};font-size:12px;margin-top:2px">${escapeHtml(line.detail)}</div>`
			: '',
		href
			? `<div style="margin-top:6px"><a href="${escapeHtml(href)}" style="color:#2563eb;font-size:13px;font-weight:700;text-decoration:none">${escapeHtml(line.action ?? 'Open')} &rarr;</a></div>`
			: ''
	];
	return (
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;border-radius:12px;margin:8px 0;border-collapse:separate;${compact ? 'table-layout:fixed;' : ''}">` +
		`<tr><td width="${size}" valign="top" style="padding:12px">${thumb}</td>` +
		`<td valign="top" style="padding:12px 12px 12px 0;${compact ? 'overflow-wrap:anywhere;word-break:break-word;' : ''}">${parts.join('')}</td></tr></table>`
	);
}

function brief(value: string, limit: number): string {
	const chars = Array.from(
		value
			.replace(/[\u2013\u2014]/g, '. ')
			.replace(/\s+/g, ' ')
			.trim()
	);
	return chars.length > limit
		? `${chars
				.slice(0, limit - 1)
				.join('')
				.trimEnd()}…`
		: chars.join('');
}

function compactLine(line: MailLine): MailLine {
	return {
		...line,
		title: line.title ? brief(line.title, 64) : undefined,
		text: brief(line.text, 72),
		detail: line.detail ? brief(line.detail, 96) : undefined
	};
}

function renderDigest(opts: {
	intro: string;
	blocks: MailBlock[];
	footer: string;
	appUrl: string;
}): RenderedMail {
	const text: string[] = ['DAILY BRIEF', opts.intro, ''];
	const html = [
		'<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#1c1917;font-size:14px;line-height:1.4">',
		'<h1 style="font-size:22px;line-height:1.2;margin:0 0 4px">Daily brief</h1>',
		`<p style="margin:0 0 16px;font-size:12px;color:#78716c">${escapeHtml(opts.intro)}</p>`
	];
	const blocks = opts.blocks.filter(
		(b) => b.groups.some((g) => g.lines.length) || b.empty || b.summary
	);
	for (const block of blocks) {
		if (block.id === 'action' && !block.groups.some((g) => g.lines.length)) continue;
		text.push(block.heading.toUpperCase());
		html.push(`<h2 style="font-size:15px;margin:18px 0 6px">${escapeHtml(block.heading)}</h2>`);
		if (block.summary) {
			text.push(block.summary);
			html.push(
				`<p style="margin:0 0 8px;color:#57534e;font-size:13px">${escapeHtml(block.summary)}</p>`
			);
		}
		const hasLines = block.groups.some((g) => g.lines.length);
		if (!hasLines && block.empty) {
			text.push(block.empty);
			html.push(`<p style="margin:0;color:#78716c;font-size:13px">${escapeHtml(block.empty)}</p>`);
		}
		let remaining = block.id === 'action' ? 5 : 3;
		for (const group of block.groups) {
			const lines = group.lines.slice(0, remaining);
			if (!lines.length) continue;
			remaining -= lines.length;
			if (group.label) {
				text.push(`  ${brief(group.label, 64)}`);
				html.push(
					`<p style="margin:8px 0 4px;color:#78716c;font-size:11px;font-weight:600">${escapeHtml(brief(group.label, 64))}</p>`
				);
			}
			for (const raw of lines) {
				const line = compactLine(raw);
				if (line.title) {
					text.push(...cardText(line));
					html.push(cardHtml(line, true));
				} else {
					const href = safeHref(line.href);
					text.push(`  - ${line.text}`);
					if (line.detail) text.push(`    ${line.detail}`);
					if (href) text.push(`    ${line.action ?? 'Open'}: ${href}`);
					html.push(
						`<p style="margin:0;padding:8px 0;border-bottom:1px solid #f5f5f4;font-size:13px;color:${line.tone === 'error' ? '#b91c1c' : '#44403c'}">${escapeHtml(line.text)}${line.detail ? `<br><span style="font-size:12px;color:#78716c">${escapeHtml(line.detail)}</span>` : ''}${href ? `<br><a href="${escapeHtml(href)}" style="font-size:12px;font-weight:600;color:#2563eb;text-decoration:none">${escapeHtml(line.action ?? 'Open')} &rarr;</a>` : ''}</p>`
					);
				}
			}
		}
		const total =
			block.itemCount ?? block.groups.reduce((sum, group) => sum + group.lines.length, 0);
		const shown = (block.id === 'action' ? 5 : 3) - remaining;
		const more = block.id !== 'action' && total > shown;
		const href = safeHref(block.href) ?? (more ? safeHref(opts.appUrl) : null);
		if (href && (more || block.id === 'top-posts')) {
			text.push(`${block.action ?? 'View all'}: ${href}`);
			html.push(
				`<p style="margin:6px 0 0"><a href="${escapeHtml(href)}" style="font-size:12px;color:#2563eb;font-weight:600;text-decoration:none">${escapeHtml(block.action ?? 'View all')} &rarr;</a></p>`
			);
		}
		text.push('');
	}
	const calendar = safeHref(opts.appUrl ? `${opts.appUrl}/calendar` : undefined);
	const settings = safeHref(opts.appUrl ? `${opts.appUrl}/settings#notifications` : undefined);
	if (calendar) {
		text.push(`Open calendar: ${calendar}`);
		html.push(
			`<p style="margin:20px 0 12px"><a href="${escapeHtml(calendar)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#1c1917;color:#fff;font-size:13px;font-weight:600;text-decoration:none">Open calendar</a></p>`
		);
	}
	if (settings) text.push(`Notification settings: ${settings}`);
	html.push(
		`<p style="margin:12px 0 0;font-size:11px;color:#78716c">${settings ? `<a href="${escapeHtml(settings)}" style="color:#78716c">Notification settings</a>` : 'CogSend'}</p></div>`
	);
	return { text: text.join('\n'), html: html.join('') };
}

function cardText(line: MailLine): string[] {
	const href = safeHref(line.href);
	const out = [`  ${line.badge ? `[${line.badge.text.toUpperCase()}] ` : ''}${line.title ?? ''}`];
	out.push(`    ${line.text}`);
	if (line.detail) out.push(`    ${line.detail}`);
	if (href) out.push(`    ${line.action ?? 'Open'}: ${href}`);
	return out;
}

export interface RenderedMail {
	text: string;
	html: string;
}

export function renderBlocks(opts: {
	intro: string;
	blocks: MailBlock[];
	footer: string;
	appUrl: string;
	/** Daily summaries use a bounded, compact layout; immediate alerts stay unchanged. */
	compact?: boolean;
}): RenderedMail {
	if (opts.compact) return renderDigest(opts);
	const text: string[] = [opts.intro, ''];
	const html: string[] = [
		'<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1c1917;max-width:640px">',
		`<p>${escapeHtml(opts.intro)}</p>`
	];
	for (const block of opts.blocks) {
		text.push(block.heading.toUpperCase());
		html.push(
			`<h2 style="font-size:15px;margin:24px 0 4px;border-bottom:1px solid #e7e5e4;padding-bottom:4px">${escapeHtml(block.heading)}</h2>`
		);
		if (block.summary) {
			text.push(block.summary);
			html.push(`<p style="margin:4px 0;color:#57534e">${escapeHtml(block.summary)}</p>`);
		}
		const hasLines = block.groups.some((g) => g.lines.length);
		if (!hasLines && block.empty) {
			text.push(block.empty);
			html.push(`<p style="margin:4px 0;color:#78716c">${escapeHtml(block.empty)}</p>`);
		}
		for (const group of block.groups) {
			if (!group.lines.length) continue;
			if (group.label) {
				text.push('', `  ${group.label}`);
				html.push(`<p style="margin:12px 0 2px;font-weight:700">${escapeHtml(group.label)}</p>`);
			}
			if (group.lines.some((l) => l.title)) {
				for (const line of group.lines) {
					text.push(...cardText(line), '');
					html.push(cardHtml(line));
				}
				continue;
			}
			html.push('<ul style="margin:0;padding-left:20px">');
			for (const line of group.lines) {
				const href = safeHref(line.href);
				text.push(`  - ${line.text}`);
				if (line.detail) text.push(`    ${line.detail}`);
				if (href) text.push(`    ${href}`);
				const body = href
					? `<a href="${escapeHtml(href)}" style="color:#1c1917">${escapeHtml(line.text)}</a>`
					: escapeHtml(line.text);
				const color = line.tone === 'error' ? '#b91c1c' : '#78716c';
				const detail = line.detail
					? `<br><span style="color:${color};font-size:13px">${escapeHtml(line.detail)}</span>`
					: '';
				html.push(`<li style="margin:4px 0">${body}${detail}</li>`);
			}
			html.push('</ul>');
		}
		text.push('');
	}
	const settings = opts.appUrl ? `${opts.appUrl}/settings#notifications` : null;
	text.push('--', opts.footer);
	if (settings) text.push(`Change what you get: ${settings}`);
	html.push(
		`<p style="margin-top:32px;font-size:12px;color:#78716c">${escapeHtml(opts.footer)}${
			settings
				? ` <a href="${escapeHtml(settings)}" style="color:#78716c">Change what you get</a>.`
				: ''
		}</p>`,
		'</div>'
	);
	return { text: text.join('\n'), html: html.join('') };
}

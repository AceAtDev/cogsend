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
function cardHtml(line: MailLine): string {
	const href = safeHref(line.href);
	const image = safeHref(line.image);
	const thumb = image
		? `<img src="${escapeHtml(image)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;object-fit:cover;border-radius:8px;background:#f5f5f4">`
		: '<div style="width:64px;height:64px;border-radius:8px;background:#f5f5f4;color:#a8a29e;font-size:11px;line-height:64px;text-align:center">Text</div>';
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
		'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;border-radius:12px;margin:8px 0;border-collapse:separate">' +
		`<tr><td width="64" valign="top" style="padding:12px">${thumb}</td>` +
		`<td valign="top" style="padding:12px 12px 12px 0">${parts.join('')}</td></tr></table>`
	);
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
}): RenderedMail {
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

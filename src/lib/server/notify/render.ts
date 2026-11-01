import type { MailBlock } from './events';

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

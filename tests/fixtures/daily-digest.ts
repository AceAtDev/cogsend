import type { MailBlock } from '../../src/lib/server/notify/events';

/** Synthetic layout fixtures. These are not delivery records. */
export function dailyDigestFixture(busy = false): MailBlock[] {
	return [
		...(busy
			? [
					{
						id: 'action',
						heading: 'Needs attention',
						groups: [
							{
								lines: [
									{
										text: '2 posts need review',
										href: 'https://cogsend.example/review',
										action: 'Review posts'
									},
									{
										text: '1 post failed',
										detail: 'Account access expired.',
										tone: 'error' as const,
										href: 'https://cogsend.example/accounts',
										action: 'Reconnect'
									}
								]
							}
						]
					}
				]
			: []),
		{
			id: 'planned',
			heading: 'Today',
			itemCount: busy ? 8 : 0,
			summary: busy ? '8 posts scheduled' : undefined,
			empty: 'Nothing scheduled.',
			href: busy ? 'https://cogsend.example/calendar' : undefined,
			action: 'View schedule',
			groups: busy
				? [
						{
							label: 'Example brand',
							lines: Array.from({ length: 3 }, (_, i) => ({
								title: 'TikTok @example',
								text: [
									'Shrimp vs salmon: same protein, different calories.',
									'A quick breakfast comparison.',
									'Protein snacks for your next grocery run.'
								][i],
								image: `https://cogsend.example/email-fixture-${i}.png`,
								badge: { text: `${i + 1}:00 PM`, tone: 'warn' as const },
								href: `https://cogsend.example/compose?id=sample-${i}`,
								action: 'Open'
							}))
						}
					]
				: []
		},
		{
			id: 'yesterday',
			heading: 'Yesterday',
			summary: '2 TikTok drafts · 0 failed',
			groups: [
				{
					label: '465cal',
					lines: [
						{
							title: 'TikTok @465cal',
							text: '200 calories: egg whites vs whole eggs.',
							badge: { text: 'TikTok draft', tone: 'warn' },
							image: 'https://cogsend.example/email-fixture-0.png',
							href: 'https://cogsend.example/compose?id=sample-eggs',
							action: 'Open draft'
						},
						{
							title: 'TikTok @465cal',
							text: '30g of protein: parmesan vs cream cheese.',
							badge: { text: 'TikTok draft', tone: 'warn' },
							image: 'https://cogsend.example/email-fixture-1.png',
							href: 'https://cogsend.example/compose?id=sample-cheese',
							action: 'Open draft'
						}
					]
				}
			]
		},
		{
			id: 'top-posts',
			heading: 'Top post this week',
			groups: [
				{
					lines: [
						{
							title: 'Bluesky @example',
							text: 'A short product update.',
							detail: '4 likes · 2 replies',
							href: 'https://bsky.app/profile/example/post/sample',
							action: 'View post'
						}
					]
				}
			]
		}
	];
}

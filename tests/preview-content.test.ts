import { describe, expect, it } from 'vitest';
import { previewContent } from '#lib/server/preview-content.js';

describe('viewer content matches publish segmentation', () => {
	it('retains original media indices after dropping an empty thread slot', () => {
		expect(
			previewContent(' First \n---\n \n---\nThird ', {}, [{ segmentIndex: 2 }], 'mastodon')
		).toEqual({
			previewSegments: ['First', 'Third'],
			previewSegmentIndices: [0, 2]
		});
	});

	it('retains a media-only segment, including Windows newlines', () => {
		expect(
			previewContent('First\r\n---\r\n \r\n---\r\nThird', {}, [{ segmentIndex: 1 }], 'bluesky')
		).toEqual({
			previewSegments: ['First', '', 'Third'],
			previewSegmentIndices: [0, 1, 2]
		});
	});

	it('uses explicit ordered thread segments even when the body differs', () => {
		expect(
			previewContent('Fallback', { threadSegments: ['First', '', 'Third'] }, [], 'mastodon')
		).toEqual({
			previewSegments: ['First', '', 'Third'],
			previewSegmentIndices: [0, 1, 2]
		});
	});

	it.each(['tiktok', 'instagram', 'linkedin'])(
		'flattens %s posts without hiding later-segment media',
		(platform) => {
			expect(
				previewContent(
					'Fallback',
					{ threadSegments: ['First', '', 'Third'] },
					[{ segmentIndex: 2 }],
					platform
				)
			).toEqual({
				previewSegments: ['First\n\nThird']
			});
		}
	);

	it('ignores a singleton explicit override like normalization does', () => {
		expect(previewContent('Actual body', { threadSegments: ['Ignored'] }, [], 'mastodon')).toEqual({
			previewSegments: ['Actual body'],
			previewSegmentIndices: [0]
		});
	});
});

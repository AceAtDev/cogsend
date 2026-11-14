/**
 * Physical-size preview math. A CSS centimetre is a fixed 96/2.54 px and is
 * almost never a real centimetre on the reviewer's monitor, so real size needs
 * a per-screen calibration (px per physical cm) measured against a bank card.
 */

export type PhoneSpec = {
	id: string;
	label: string;
	/** Diagonal marketed size, for the label only. */
	inches: number;
	/** Native panel pixels and density: the physical size derives from these. */
	panel: { width: number; height: number; ppi: number };
	/** Logical viewport the apps lay out in (iOS points, Android dp). */
	viewport: { width: number; height: number };
	statusBar: number;
	homeIndicator: number;
};

export const PHONES: PhoneSpec[] = [
	{
		id: 'iphone-6-1',
		label: 'iPhone 15 / 16',
		inches: 6.1,
		panel: { width: 1179, height: 2556, ppi: 460 },
		viewport: { width: 393, height: 852 },
		statusBar: 54,
		homeIndicator: 34
	},
	{
		id: 'iphone-6-9',
		label: 'iPhone 16 Pro Max',
		inches: 6.9,
		panel: { width: 1320, height: 2868, ppi: 460 },
		viewport: { width: 440, height: 956 },
		statusBar: 62,
		homeIndicator: 34
	},
	{
		id: 'iphone-se',
		label: 'iPhone SE',
		inches: 4.7,
		panel: { width: 750, height: 1334, ppi: 326 },
		viewport: { width: 375, height: 667 },
		statusBar: 20,
		homeIndicator: 0
	},
	{
		id: 'pixel-8',
		label: 'Pixel 8',
		inches: 6.2,
		panel: { width: 1080, height: 2400, ppi: 428 },
		viewport: { width: 412, height: 915 },
		statusBar: 32,
		homeIndicator: 24
	},
	{
		id: 'galaxy-s24',
		label: 'Galaxy S24',
		inches: 6.2,
		panel: { width: 1080, height: 2340, ppi: 416 },
		viewport: { width: 360, height: 780 },
		statusBar: 28,
		homeIndicator: 20
	}
];

export const DEFAULT_PHONE = PHONES[0];

export function phoneById(id: string | null | undefined): PhoneSpec {
	return PHONES.find((phone) => phone.id === id) ?? DEFAULT_PHONE;
}

const CM_PER_INCH = 2.54;

/** Physical screen size of the phone's display, in cm. */
export function screenCm(phone: PhoneSpec): { width: number; height: number } {
	return {
		width: (phone.panel.width / phone.panel.ppi) * CM_PER_INCH,
		height: (phone.panel.height / phone.panel.ppi) * CM_PER_INCH
	};
}

/** ISO/IEC 7810 ID-1: every bank, ID and loyalty card. */
export const CARD_CM = { width: 8.56, height: 5.398 };

/** The CSS reference pixel: right only on an uncommon 96 dpi monitor at 100% zoom. */
export const CSS_PX_PER_CM = 96 / CM_PER_INCH;

/** Phones lay out near 60 CSS px per real cm, which beats the CSS default as a guess there. */
export function guessPxPerCm(viewportWidth: number, coarsePointer: boolean): number {
	return coarsePointer && viewportWidth < 600 ? 60 : CSS_PX_PER_CM;
}

export const PX_PER_CM_RANGE = { min: 20, max: 120 };

export function clampPxPerCm(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	return Math.min(PX_PER_CM_RANGE.max, Math.max(PX_PER_CM_RANGE.min, value));
}

/**
 * How to draw a phone at true size: the app renders in the phone's own viewport
 * units and is scaled so its width equals the real screen width. When the frame
 * does not fit the stage it is shrunk, and `fit` reports by how much so the UI
 * never presents a shrunken phone as real size.
 */
export function phoneLayout(
	phone: PhoneSpec,
	pxPerCm: number,
	stage: { width: number; height: number },
	bezelCm = 0.3
): { scale: number; fit: number; frame: { width: number; height: number } } {
	const screen = screenCm(phone);
	const trueScale = (screen.width * pxPerCm) / phone.viewport.width;
	const frame = {
		width: (screen.width + bezelCm * 2) * pxPerCm,
		height: (screen.height + bezelCm * 2) * pxPerCm
	};
	const fit =
		stage.width > 0 && stage.height > 0
			? Math.min(1, stage.width / frame.width, stage.height / frame.height)
			: 1;
	return {
		scale: trueScale * fit,
		fit,
		frame: { width: frame.width * fit, height: frame.height * fit }
	};
}

/** On-screen pixels back to physical centimetres, undoing any fit shrink. */
export function toCm(px: number, pxPerCm: number, fit = 1): number {
	return px / (pxPerCm * (fit || 1));
}

export function formatCm(width: number, height: number): string {
	return `${width.toFixed(1)} × ${height.toFixed(1)} cm`;
}

/**
 * Instagram feed posts are cropped into 4:5 (portrait) to 1.91:1 (landscape);
 * TikTok photo mode and immersive video letterbox instead of cropping.
 */
export function feedAspect(platform: string, aspect: number): number {
	if (platform === 'instagram') return Math.min(1.91, Math.max(0.8, aspect));
	return aspect;
}

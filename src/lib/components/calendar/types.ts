import type { CalendarChannel, CalendarItem } from '#lib/domain/calendar.js';

/** An item with its account resolved and its place on the grid, which is what every view draws. */
export type ViewItem = CalendarItem & { channel: CalendarChannel; day: string; hour: number };

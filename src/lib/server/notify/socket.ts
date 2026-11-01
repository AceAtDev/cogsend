import { NO_SOCKETS, type SmtpConnect } from './smtp';

/**
 * Workers TCP sockets. Cloudflare blocks outbound port 25 only; 465 and 587 are
 * allowed. Imported on first use rather than at load: `vite dev` runs the app
 * in Node, where the module does not exist, and the scheduler that imports this
 * file must still load there.
 */
export const workersConnect: SmtpConnect = async (address, options) => {
	let sockets: typeof import('cloudflare:sockets');
	try {
		sockets = await import('cloudflare:sockets');
	} catch {
		throw new Error(NO_SOCKETS);
	}
	return sockets.connect(address, options);
};

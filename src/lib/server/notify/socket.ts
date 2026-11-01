import { connect } from 'cloudflare:sockets';
import type { SmtpConnect } from './smtp';

/** Workers TCP sockets. Cloudflare blocks outbound port 25 only; 465 and 587 are allowed. */
export const workersConnect: SmtpConnect = (address, options) => connect(address, options);

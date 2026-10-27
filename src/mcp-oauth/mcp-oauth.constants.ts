import { PAT_SCOPES } from '../access-tokens/access-token.util.js';

/** Scopes an app can ask for; the same vocabulary as personal access tokens. */
export const OAUTH_SCOPES = PAT_SCOPES;

export const ACCESS_TOKEN_PREFIX = 'stella_oat_';
export const REFRESH_TOKEN_PREFIX = 'stella_ort_';
export const AUTHORIZATION_CODE_PREFIX = 'stella_oac_';

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// How long the user has on the consent page.
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
// How long the client has to exchange the code it was redirected with.
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

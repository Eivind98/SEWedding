'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
	MS_CLIENT_ID,
	MS_CLIENT_SECRET,
	MS_REFRESH_TOKEN,
	// Relative to the app folder, not to the drive root
	ONEDRIVE_FOLDER = 'Myndir',
	TOKEN_FILE = '/data/refresh_token',
	TOKEN_ENCRYPTION_KEY,
	UPLOAD_PASSCODE = '',
	ALLOWED_ORIGINS = '',
	RATE_LIMIT_WINDOW_MS = '60000',
	RATE_LIMIT_MAX_REQUESTS = '60',
	TRUST_PROXY = '', // the Dockerfile sets this: CapRover always fronts us
	PORT = 3000, // the Dockerfile overrides this to 80 for CapRover
	// Loopback by default so a local dev run is not exposed to the network;
	// the Dockerfile sets 0.0.0.0 because the container must accept traffic
	HOST = '127.0.0.1',
} = process.env;

// Env values can arrive with stray whitespace: a .env saved with Windows
// CRLF endings leaves a carriage return on every value, and Microsoft
// rejects a token carrying one as an unmatchable grant.
const clean = (value) => String(value || '').trim();

// The image puts the site in public/; running from a checkout it sits alongside
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
	? path.join(__dirname, 'public')
	: __dirname;

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.svg': 'image/svg+xml',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
};

// The page loads nothing from anywhere but this origin: the OpenStreetMap
// frames and the Pinterest hotlinks are commented out in index.html, so
// img-src and frame-src can stay shut. connect-src is the one exception the
// upload needs - the browser PUTs photo chunks straight to whatever host
// Microsoft names in the upload URL, and that host varies by account
// (1drv.com, sharepoint.com), so it cannot be pinned to a literal.
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'", // index.html carries one style attribute
	"img-src 'self' data:",
	"font-src 'self' data:",
	"frame-src 'none'",
	"connect-src 'self' https:",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join('; ');

const setSecurityHeaders = (response) => {
	response.setHeader('X-Content-Type-Options', 'nosniff');
	response.setHeader('Referrer-Policy', 'no-referrer');
	response.setHeader('X-Frame-Options', 'DENY');
	response.setHeader(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=()'
	);
	response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
};

// An empty list allows every origin, which is what a deployment behind an
// unknown domain wants. Set ALLOWED_ORIGINS to pin the API to the real site.
const allowedOrigins = clean(ALLOWED_ORIGINS)
	.split(',')
	.map((entry) => entry.trim())
	.filter(Boolean);

const isOriginAllowed = (value) => {
	if (!allowedOrigins.length) {
		return true;
	}
	if (!value) {
		return false;
	}
	try {
		return allowedOrigins.includes(new URL(value).origin);
	} catch {
		return false;
	}
};

const toPositiveInt = (value, fallback) => {
	const parsed = Number.parseInt(clean(value), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const rateWindowMs = toPositiveInt(RATE_LIMIT_WINDOW_MS, 60000);
const rateMax = toPositiveInt(RATE_LIMIT_MAX_REQUESTS, 60);
const rateStore = new Map();

const trustProxy = ['1', 'true', 'yes'].includes(clean(TRUST_PROXY).toLowerCase());

// X-Forwarded-For is only worth reading when something we trust wrote it -
// otherwise a client hands itself a fresh rate-limit bucket per request. Even
// then it is the rightmost entry that counts: CapRover's nginx appends the peer
// it actually saw, so everything to the left of it is whatever the caller
// claimed on the way in.
const getClientIp = (request) => {
	const forwarded = trustProxy && clean(request.headers['x-forwarded-for']);
	if (forwarded) {
		return forwarded.split(',').pop().trim();
	}
	return request.socket.remoteAddress || 'unknown';
};

// A fixed window per client. The endpoint is unauthenticated and every call
// spends a Graph request, so this is about stopping a script, not a guest -
// the default leaves room for a phone emptying its camera roll.
const isRateLimited = (request) => {
	const ip = getClientIp(request);
	const now = Date.now();
	const seen = rateStore.get(ip);

	if (!seen || now - seen.windowStart >= rateWindowMs) {
		rateStore.set(ip, { count: 1, windowStart: now });
		return false;
	}

	seen.count += 1;
	return seen.count > rateMax;
};

// The shared code from the invitation. Left unset, the endpoint stays open to
// anyone who can load the page - which is the previous behaviour, and is
// announced at startup so it cannot be forgotten silently.
const uploadPasscode = clean(UPLOAD_PASSCODE);

// Both sides are hashed before the comparison: timingSafeEqual needs equal
// lengths, and hashing supplies that without leaking how long the real
// passcode is. The compare itself is constant-time so a guess cannot be
// narrowed down character by character.
const passcodeMatches = (supplied) => {
	const digest = (value) =>
		crypto.createHash('sha256').update(String(value), 'utf8').digest();

	return crypto.timingSafeEqual(digest(clean(supplied)), digest(uploadPasscode));
};

// A short code invites guessing, and the ordinary rate limit is far too loose
// to stop it. Wrong codes get their own, much tighter budget.
//
// Five tries per five minutes. Guests arrive on their own mobile connections
// rather than one shared network, so a locked-out address is one person who
// mistyped, not a room full of them - and that person waits five minutes.
// A locked-out client is refused even with the right passcode, because
// checking it first would let an attacker test codes as fast as they like.
const PASSCODE_LOCKOUT_MS =
	toPositiveInt(process.env.PASSCODE_LOCKOUT_MINUTES, 5) * 60 * 1000;
const PASSCODE_MAX_FAILURES = toPositiveInt(
	process.env.PASSCODE_MAX_FAILURES,
	5
);
const passcodeFailures = new Map();

// Returns null when the request may go ahead, or the [status, body] to refuse
// it with. Shared by the login check and the upload itself, so the two can
// never drift apart on what counts as a valid passcode.
const passcodeRejection = (request) => {
	if (!uploadPasscode) {
		return null;
	}

	const ip = getClientIp(request);
	if (isLockedOut(ip)) {
		return [429, { error: 'too_many_attempts' }];
	}

	const supplied = request.headers['x-upload-passcode'];
	if (!clean(supplied)) {
		return [401, { error: 'passcode_required' }];
	}
	if (!passcodeMatches(supplied)) {
		recordPasscodeFailure(ip);
		return [401, { error: 'passcode_invalid' }];
	}

	// A guest who gets it right has clearly not been guessing
	passcodeFailures.delete(ip);
	return null;
};

const isLockedOut = (ip) => {
	const seen = passcodeFailures.get(ip);
	if (!seen || Date.now() - seen.windowStart >= PASSCODE_LOCKOUT_MS) {
		return false;
	}
	return seen.count >= PASSCODE_MAX_FAILURES;
};

const recordPasscodeFailure = (ip) => {
	const now = Date.now();
	const seen = passcodeFailures.get(ip);
	if (!seen || now - seen.windowStart >= PASSCODE_LOCKOUT_MS) {
		passcodeFailures.set(ip, { count: 1, windowStart: now });
		return;
	}
	seen.count += 1;
};

// Both maps would otherwise keep one entry per IP for the life of the process
setInterval(() => {
	const now = Date.now();
	for (const [ip, seen] of rateStore) {
		if (now - seen.windowStart >= rateWindowMs * 2) {
			rateStore.delete(ip);
		}
	}
	for (const [ip, seen] of passcodeFailures) {
		if (now - seen.windowStart >= PASSCODE_LOCKOUT_MS) {
			passcodeFailures.delete(ip);
		}
	}
}, Math.min(rateWindowMs, 60000)).unref();

// Optional hardening: with TOKEN_ENCRYPTION_KEY set the persisted token is
// sealed with AES-256-GCM, so a copy of the /data volume on its own - a
// snapshot, a backup - is useless without the key from the environment.
// Without the key the file is written as before: uploads must never break
// over an extra that was not configured.
const parseEncryptionKey = (value) => {
	const raw = clean(value);
	if (!raw) {
		return null;
	}
	const key = /^[\da-fA-F]{64}$/.test(raw)
		? Buffer.from(raw, 'hex')
		: Buffer.from(raw, 'base64');
	return key.length === 32 ? key : null;
};

const encryptionKey = parseEncryptionKey(TOKEN_ENCRYPTION_KEY);

const encryptToken = (token) => {
	const iv = crypto.randomBytes(12); // the size GCM is specified around
	const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
	const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);

	return JSON.stringify({
		version: 1,
		alg: 'AES-256-GCM',
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: sealed.toString('base64'),
	});
};

const decryptToken = (envelope) => {
	const decipher = crypto.createDecipheriv(
		'aes-256-gcm',
		encryptionKey,
		Buffer.from(envelope.iv, 'base64')
	);
	decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

	return Buffer.concat([
		decipher.update(Buffer.from(envelope.data, 'base64')),
		decipher.final(),
	]).toString('utf8');
};

// A refresh token is never JSON, so the envelope tells the two formats apart
const readEnvelope = (stored) => {
	try {
		const parsed = JSON.parse(stored);
		return parsed && parsed.alg === 'AES-256-GCM' ? parsed : null;
	} catch {
		return null;
	}
};

const readStoredToken = () => {
	try {
		return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
	} catch (error) {
		if (error.code !== 'ENOENT') {
			console.error('could not read stored refresh token:', error.message);
		}
		return '';
	}
};

// Microsoft rotates the refresh token on every use, and CapRover restarts the
// container on every deploy, so the current one has to outlive the process.
const saveRefreshToken = (token) => {
	try {
		fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });

		// Write then rename: a crash mid-write cannot leave a truncated file
		// where the only copy of a rotated grant is supposed to be.
		const temporary = `${TOKEN_FILE}.tmp-${process.pid}`;
		fs.writeFileSync(temporary, encryptionKey ? encryptToken(token) : token, {
			mode: 0o600,
		});
		fs.renameSync(temporary, TOKEN_FILE);
	} catch (error) {
		console.error('could not persist refresh token:', error.message);
	}
};

const loadRefreshToken = () => {
	const stored = readStoredToken();
	if (!stored) {
		return clean(MS_REFRESH_TOKEN);
	}

	const envelope = readEnvelope(stored);
	if (!envelope) {
		return stored; // written before a key was configured
	}
	if (!encryptionKey) {
		console.error(
			'stored refresh token is encrypted but TOKEN_ENCRYPTION_KEY is unset'
		);
		return clean(MS_REFRESH_TOKEN);
	}

	try {
		return decryptToken(envelope);
	} catch (error) {
		console.error('could not decrypt stored refresh token:', error.message);
		return clean(MS_REFRESH_TOKEN);
	}
};

// The file is the copy that survives a restart; this is the live one the
// process refreshes against, so a rotation is never read back mid-flight.
let refreshToken = loadRefreshToken();

// Seal a token that predates the key, or the seed from the environment, rather
// than waiting for the next rotation to write the file in the wanted format.
if (refreshToken && encryptionKey && !readEnvelope(readStoredToken())) {
	saveRefreshToken(refreshToken);
}

let accessToken = null;
let accessTokenExpiry = 0;
let refreshInFlight = null;

// A guest dropping a folder of photos fires several upload-session requests at
// once. Without the shared promise every one of them spends the same refresh
// token in parallel, and Microsoft hands each caller its own rotated
// replacement - all but the last one lost.
const getAccessToken = async () => {
	if (accessToken && Date.now() < accessTokenExpiry) {
		return accessToken;
	}
	if (refreshInFlight) {
		return refreshInFlight;
	}

	refreshInFlight = (async () => {
		const response = await fetch(
			'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
			{
				method: 'POST',
				body: new URLSearchParams({
					client_id: clean(MS_CLIENT_ID),
					client_secret: clean(MS_CLIENT_SECRET),
					refresh_token: refreshToken,
					grant_type: 'refresh_token',
				}),
			}
		);

		if (!response.ok) {
			// Truncated: enough for the AADSTS code the README indexes, without
			// pasting an unbounded upstream body into the container logs
			const detail = (await response.text()).slice(0, 300);
			throw new Error(`token refresh failed (${response.status}): ${detail}`);
		}

		const token = await response.json();
		if (!token.access_token) {
			throw new Error('token refresh failed: no access_token in response');
		}

		accessToken = token.access_token;
		accessTokenExpiry =
			Date.now() + Math.max(60, Number(token.expires_in) - 300) * 1000;

		if (token.refresh_token) {
			refreshToken = token.refresh_token;
			saveRefreshToken(refreshToken);
		}
		return accessToken;
	})();

	try {
		return await refreshInFlight;
	} finally {
		refreshInFlight = null;
	}
};

// What a phone camera produces. Anything else - and that includes every
// executable, script, shortcut, installer and archive - never gets an upload
// session, so it never reaches the drive at all.
const ALLOWED_EXTENSIONS = new Set([
	'jpg',
	'jpeg',
	'png',
	'webp',
	'gif',
	'avif',
	'heic',
	'heif',
	'mp4',
	'mov',
	'm4v',
	'3gp',
]);

// Direction overrides and zero-width characters let a name render in a file
// list as "sumar.jpg" while the bytes actually end in ".exe". Control
// characters do the same trick with a different mechanism. Both come off
// before anything looks at the extension.
const stripDisguises = (value) =>
	value.replace(
		/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
		''
	);

// Returns null for anything not on the allowlist - the caller turns that into
// a refusal rather than trying to salvage a name.
const safeName = (name) => {
	const base = stripDisguises(String(name || ''))
		.split(/[\\/]/)
		.pop()
		.trim();

	const dot = base.lastIndexOf('.');
	if (dot <= 0) {
		return null;
	}

	const extension = base.slice(dot + 1).toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(extension)) {
		return null;
	}

	// Interior dots are flattened, so "sumar.jpg.exe" cannot be stored under a
	// name that still carries a second extension. The extension is rebuilt from
	// the allowlisted value rather than copied out of the guest's string.
	const stem =
		base
			.slice(0, dot)
			.replace(/[."*:<>?|]/g, '_')
			.replace(/^[.\s]+/, '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(-120) || 'mynd';

	return `${stem}.${extension}`;
};

// Every path is addressed relative to the app folder Microsoft keeps for this
// registration. The token is scoped to it, so the rest of the drive is out of
// reach even if something here got a path wrong.
const APP_FOLDER =
	'https://graph.microsoft.com/v1.0/me/drive/special/approot';

// '..' is dropped rather than trusted: the scope already stops it escaping the
// app folder, but a mistyped env var should not send photos somewhere odd.
const uploadFolder = clean(ONEDRIVE_FOLDER)
	.split('/')
	.map((segment) => segment.trim())
	.filter((segment) => segment && segment !== '.' && segment !== '..');

const createUploadSession = async (name) => {
	const token = await getAccessToken();
	const itemPath = [...uploadFolder, name].map(encodeURIComponent).join('/');

	const response = await fetch(
		`${APP_FOLDER}:/${itemPath}:/createUploadSession`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				item: { '@microsoft.graph.conflictBehavior': 'rename' },
			}),
		}
	);

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw new Error(
			`createUploadSession failed (${response.status}): ${detail}`
		);
	}

	return response.json();
};

const readBody = (request) =>
	new Promise((resolve, reject) => {
		let body = '';
		request.on('data', (chunk) => {
			body += chunk;
			if (body.length > 4096) {
				request.destroy();
				reject(new Error('body too large'));
			}
		});
		request.on('end', () => resolve(body));
		request.on('error', reject);
	});

const sendJson = (response, status, payload) => {
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
	});
	response.end(JSON.stringify(payload));
};

// Exactly what the Dockerfile copies into the image. Running from a checkout
// the repo root doubles as the web root, so an allowlist is what keeps .env,
// .refresh_token and .git from being served to anyone who asks.
const SITE_FILES = new Set([
	'index.html',
	'style.css',
	'custom.css',
	'script.js',
]);

const isServable = (segments) => {
	if (segments.some((segment) => segment.startsWith('.'))) {
		return false;
	}
	return SITE_FILES.has(segments.join('/')) || segments[0] === 'assets';
};

// A stray percent sign is enough to make decodeURIComponent throw, and an
// uncaught throw in the request handler takes the whole process down. Anything
// undecodable is simply not a path we serve.
const decodePath = (url) => {
	try {
		return decodeURIComponent(new URL(url, 'http://x').pathname);
	} catch {
		return null;
	}
};

const serveStatic = (request, response) => {
	const pathname = decodePath(request.url);
	if (pathname === null) {
		response.writeHead(404).end('Not found');
		return;
	}

	const segments = pathname.split('/').filter(Boolean);
	const wanted = segments.length ? segments : ['index.html'];

	// 404 rather than 403: do not confirm what exists outside the allowlist
	if (!isServable(wanted)) {
		response.writeHead(404).end('Not found');
		return;
	}

	const filePath = path.join(PUBLIC_DIR, wanted.join('/'));
	if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
		response.writeHead(403).end('Forbidden');
		return;
	}

	fs.readFile(filePath, (error, content) => {
		if (error) {
			response.writeHead(404).end('Not found');
			return;
		}
		response.writeHead(200, {
			'Content-Type':
				MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
		});
		response.end(content);
	});
};

const handleRequest = async (request, response) => {
	setSecurityHeaders(response);

	if (request.method === 'POST' && request.url === '/api/upload-session') {
		if (!isOriginAllowed(request.headers.origin)) {
			sendJson(response, 403, { error: 'origin_not_allowed' });
			return;
		}
		if (isRateLimited(request)) {
			sendJson(response, 429, { error: 'rate_limited' });
			return;
		}

		const rejection = passcodeRejection(request);
		if (rejection) {
			sendJson(response, rejection[0], rejection[1]);
			return;
		}

		if (
			!clean(request.headers['content-type'])
				.toLowerCase()
				.startsWith('application/json')
		) {
			sendJson(response, 415, { error: 'unsupported_media_type' });
			return;
		}

		let name;
		try {
			({ name } = JSON.parse(await readBody(request)) || {});
		} catch {
			sendJson(response, 400, { error: 'invalid_json' });
			return;
		}

		if (typeof name !== 'string' || !name.trim() || name.length > 300) {
			sendJson(response, 400, { error: 'invalid_name' });
			return;
		}

		// No allowlisted extension, no upload session - an executable never gets
		// as far as a URL it could be written to.
		const storedName = safeName(name);
		if (!storedName) {
			sendJson(response, 415, { error: 'unsupported_file_type' });
			return;
		}

		try {
			const session = await createUploadSession(storedName);
			sendJson(response, 200, { uploadUrl: session.uploadUrl });
		} catch (error) {
			console.error('upload-session failed:', error.message);
			sendJson(response, 502, { error: 'upload_session_failed' });
		}
		return;
	}

	// Checks a passcode on its own, so the page can tell a guest they are in
	// before they pick any files. Costs nothing upstream - it never touches
	// Microsoft - and counts towards the same wrong-guess budget as an upload.
	if (request.method === 'POST' && request.url === '/api/upload-login') {
		if (!isOriginAllowed(request.headers.origin)) {
			sendJson(response, 403, { error: 'origin_not_allowed' });
			return;
		}
		if (isRateLimited(request)) {
			sendJson(response, 429, { error: 'rate_limited' });
			return;
		}

		const rejection = passcodeRejection(request);
		if (rejection) {
			sendJson(response, rejection[0], rejection[1]);
			return;
		}

		sendJson(response, 200, { ok: true });
		return;
	}

	// Lets the page decide whether to ask for a code, so the field never shows
	// up when no passcode is configured. It reveals only whether one is needed,
	// which any guest finds out on the first upload anyway.
	if (request.method === 'GET' && request.url === '/api/upload-config') {
		sendJson(response, 200, { passcodeRequired: Boolean(uploadPasscode) });
		return;
	}

	if (request.method === 'GET' || request.method === 'HEAD') {
		serveStatic(request, response);
		return;
	}

	response.writeHead(405).end('Method not allowed');
};

// Nothing a single request does should be able to stop the site serving. An
// unhandled rejection out of the handler would otherwise end the process, and
// on CapRover that is a restart loop for as long as someone keeps asking.
const server = http.createServer((request, response) => {
	handleRequest(request, response).catch((error) => {
		console.error('request failed:', error.message);
		if (response.headersSent) {
			response.destroy();
			return;
		}
		sendJson(response, 500, { error: 'server_error' });
	});
});

const missing = Object.entries({
	MS_CLIENT_ID,
	MS_CLIENT_SECRET,
})
	.filter(([, value]) => !clean(value))
	.map(([key]) => key);

if (!refreshToken) {
	missing.push('MS_REFRESH_TOKEN');
}

server.listen(PORT, HOST, () => {
	console.log(`listening on ${HOST}:${PORT}`);
	console.log(
		`upload rate limit: ${rateMax} requests / ${rateWindowMs}ms per client`
	);
	console.log(
		allowedOrigins.length
			? `upload origin allowlist: ${allowedOrigins.join(', ')}`
			: 'upload origin allowlist: off (ALLOWED_ORIGINS not set)'
	);
	console.log(
		encryptionKey
			? 'stored refresh token: encrypted at rest'
			: 'stored refresh token: plaintext (set TOKEN_ENCRYPTION_KEY to encrypt)'
	);
	console.log(
		uploadPasscode
			? `upload passcode: required (${PASSCODE_MAX_FAILURES} wrong guesses locks a client out for ${PASSCODE_LOCKOUT_MS / 60000} minutes)`
			: 'upload passcode: NOT SET - anyone who can load the site can upload'
	);

	if (missing.length) {
		console.log('');
		console.log(`WARNING: uploads are disabled - missing ${missing.join(', ')}`);
		console.log('The site will serve, but /api/upload-session will fail.');
		console.log('Run `node get-refresh-token.js` to create a .env.');
		console.log('');
	}
});

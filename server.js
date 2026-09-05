'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
	UPLOAD_DIR = '/data/uploads',
	UPLOAD_PASSCODE = '',
	// Per file. A phone video runs to a few hundred MB; anything larger is
	// almost certainly a mistake or an attempt to fill the disk.
	MAX_FILE_MB = '512',
	// Everything together. The CapRover box runs other apps, and a full disk
	// takes all of them down, not just this one. MAX_TOTAL_MB wins if set, for
	// when a whole gigabyte is too coarse.
	MAX_TOTAL_GB = '20',
	MAX_TOTAL_MB = '',
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
// CRLF endings leaves a carriage return on every value.
const clean = (value) => String(value || '').trim();

const toPositiveInt = (value, fallback) => {
	const parsed = Number.parseInt(clean(value), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const uploadDir = clean(UPLOAD_DIR) || '/data/uploads';
const tempDir = path.join(uploadDir, '.incoming');
const maxFileBytes = toPositiveInt(MAX_FILE_MB, 512) * 1024 * 1024;
const maxTotalBytes = clean(MAX_TOTAL_MB)
	? toPositiveInt(MAX_TOTAL_MB, 20480) * 1024 * 1024
	: toPositiveInt(MAX_TOTAL_GB, 20) * 1024 * 1024 * 1024;

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

// The page now loads and uploads to nothing but this origin, so every source
// can be pinned to 'self'. The directive that earns its keep is script-src:
// nothing but our own script.js may execute.
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'", // index.html carries one style attribute
	"img-src 'self' data:",
	"font-src 'self' data:",
	"frame-src 'none'",
	"connect-src 'self'",
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

// Guards starting an upload and logging in. Chunks of an accepted upload are
// deliberately exempt: they are already bounded by the file's declared size.
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

// The shared code from the invitation. Left unset, uploads stay open to anyone
// who can load the page - announced at startup so it cannot be missed.
const uploadPasscode = clean(UPLOAD_PASSCODE);

// Both sides are hashed before the comparison: timingSafeEqual needs equal
// lengths, and hashing supplies that without leaking how long the real
// passcode is. The compare itself is constant-time.
const passcodeMatches = (supplied) => {
	const digest = (value) =>
		crypto.createHash('sha256').update(String(value), 'utf8').digest();

	return crypto.timingSafeEqual(digest(clean(supplied)), digest(uploadPasscode));
};

// Five tries per five minutes. Guests arrive on their own mobile connections
// rather than one shared network, so a locked-out address is one person who
// mistyped. A locked-out client is refused even with the right passcode,
// because checking it first would let an attacker test codes as fast as
// they like.
const PASSCODE_LOCKOUT_MS =
	toPositiveInt(process.env.PASSCODE_LOCKOUT_MINUTES, 5) * 60 * 1000;
const PASSCODE_MAX_FAILURES = toPositiveInt(
	process.env.PASSCODE_MAX_FAILURES,
	5
);
const passcodeFailures = new Map();

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

// Returns null when the request may go ahead, or the [status, body] to refuse
// it with. Shared by every guarded endpoint so they cannot drift apart.
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

// ---------------------------------------------------------------- file names

// What a phone camera produces. Anything else - and that includes every
// executable, script, shortcut, installer and archive - is refused before a
// single byte is accepted.
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
// characters do the same trick with a different mechanism.
const stripDisguises = (value) =>
	value.replace(
		/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
		''
	);

// Returns null for anything not on the allowlist.
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

// ------------------------------------------------------------ content checks

// Now that the bytes come through this process, the extension can be checked
// against what the file actually is. A renamed .exe does not survive this.
const MAGIC = {
	jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	png: (b) =>
		b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
	gif: (b) => b.slice(0, 4).toString('latin1') === 'GIF8',
	webp: (b) =>
		b.slice(0, 4).toString('latin1') === 'RIFF' &&
		b.slice(8, 12).toString('latin1') === 'WEBP',
	// avif, heic, heif, mp4, mov, m4v and 3gp are all ISO base media files:
	// a size field, then the literal "ftyp".
	isobmff: (b) => b.slice(4, 8).toString('latin1') === 'ftyp',
};

const EXTENSION_CHECK = {
	jpg: MAGIC.jpg,
	jpeg: MAGIC.jpg,
	png: MAGIC.png,
	gif: MAGIC.gif,
	webp: MAGIC.webp,
	avif: MAGIC.isobmff,
	heic: MAGIC.isobmff,
	heif: MAGIC.isobmff,
	mp4: MAGIC.isobmff,
	mov: MAGIC.isobmff,
	m4v: MAGIC.isobmff,
	'3gp': MAGIC.isobmff,
};

const looksLikeItsExtension = (storedName, head) => {
	const extension = storedName.slice(storedName.lastIndexOf('.') + 1);
	const check = EXTENSION_CHECK[extension];
	// 12 bytes covers every signature above
	return check ? head.length >= 12 && check(head) : false;
};

// ----------------------------------------------------------------- storage

fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });

const directorySize = (dir) => {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isFile()) {
			try {
				total += fs.statSync(path.join(dir, entry.name)).size;
			} catch {
				// vanished between listing and stat - not our problem
			}
		}
	}
	return total;
};

// Counted once at boot, then kept up to date as uploads land, so a full disk
// is refused politely rather than crashing the box everything else runs on.
let usedBytes = directorySize(uploadDir);

// Anything still in .incoming at boot is from a container that was replaced
// mid-upload. Those bytes are unreachable, so reclaim them.
for (const entry of fs.readdirSync(tempDir)) {
	try {
		fs.unlinkSync(path.join(tempDir, entry));
	} catch {
		// leave it; the periodic sweep will try again
	}
}

// Claims a filename atomically, so two guests uploading "IMG_1234.jpg" at the
// same moment cannot end up writing over each other.
const claimName = (wanted) => {
	const dot = wanted.lastIndexOf('.');
	const stem = wanted.slice(0, dot);
	const extension = wanted.slice(dot);

	for (let attempt = 0; attempt < 500; attempt += 1) {
		const candidate =
			attempt === 0 ? wanted : `${stem}-${attempt + 1}${extension}`;
		const target = path.join(uploadDir, candidate);
		try {
			fs.closeSync(fs.openSync(target, 'wx'));
			return target;
		} catch (error) {
			if (error.code !== 'EEXIST') {
				throw error;
			}
		}
	}
	throw new Error('could not find a free filename');
};

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const sessions = new Map();

const discardSession = (session) => {
	sessions.delete(session.id);
	usedBytes -= session.size; // the reservation goes back
	try {
		fs.unlinkSync(session.tempPath);
	} catch {
		// already gone
	}
};

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
	for (const session of [...sessions.values()]) {
		if (now - session.touched >= SESSION_TTL_MS) {
			discardSession(session);
		}
	}
}, Math.min(rateWindowMs, 60000)).unref();

// ------------------------------------------------------------ http helpers

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
// the repo root doubles as the web root, so an allowlist is what keeps .env
// and .git from being served to anyone who asks. Uploaded photos live outside
// PUBLIC_DIR entirely and have no route at all - nothing a guest sends can be
// fetched back off this site.
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
// uncaught throw in the request handler takes the whole process down.
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

// ------------------------------------------------------------------ uploads

const startSession = async (request, response) => {
	let parsed;
	try {
		parsed = JSON.parse(await readBody(request)) || {};
	} catch {
		sendJson(response, 400, { error: 'invalid_json' });
		return;
	}

	const { name, size } = parsed;
	if (typeof name !== 'string' || !name.trim() || name.length > 300) {
		sendJson(response, 400, { error: 'invalid_name' });
		return;
	}

	const storedName = safeName(name);
	if (!storedName) {
		sendJson(response, 415, { error: 'unsupported_file_type' });
		return;
	}

	if (!Number.isSafeInteger(size) || size <= 0) {
		sendJson(response, 400, { error: 'invalid_size' });
		return;
	}
	if (size > maxFileBytes) {
		sendJson(response, 413, {
			error: 'file_too_large',
			maxBytes: maxFileBytes,
		});
		return;
	}
	if (usedBytes + size > maxTotalBytes) {
		sendJson(response, 507, { error: 'storage_full' });
		return;
	}

	const id = crypto.randomUUID();
	const session = {
		id,
		storedName,
		size,
		received: 0,
		checked: false,
		tempPath: path.join(tempDir, id),
		touched: Date.now(),
	};

	fs.closeSync(fs.openSync(session.tempPath, 'wx'));
	sessions.set(id, session);
	usedBytes += size; // reserved up front so parallel uploads cannot overcommit

	sendJson(response, 200, { id, chunkSize: 8 * 1024 * 1024 });
};

// "bytes 0-8388607/23456789"
const parseContentRange = (value) => {
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(clean(value));
	if (!match) {
		return null;
	}
	const [, start, end, total] = match.map(Number);
	if (end < start || end >= total) {
		return null;
	}
	return { start, end, total };
};

const writeChunk = (session, request, expected) =>
	new Promise((resolve, reject) => {
		const stream = fs.createWriteStream(session.tempPath, {
			flags: 'r+',
			start: session.received,
		});

		let written = 0;
		let failed = null;

		const fail = (error) => {
			if (!failed) {
				failed = error;
				stream.destroy();
				request.destroy();
				reject(error);
			}
		};

		request.on('data', (chunk) => {
			written += chunk.length;
			// A client that sends more than it declared does not get to keep
			// writing past the size we reserved for it.
			if (written > expected) {
				fail(new Error('chunk longer than its Content-Range'));
			}
		});

		request.on('error', fail);
		stream.on('error', fail);
		stream.on('finish', () => {
			if (failed) {
				return;
			}
			if (written !== expected) {
				reject(new Error('chunk shorter than its Content-Range'));
				return;
			}
			resolve(written);
		});

		request.pipe(stream);
	});

const receiveChunk = async (request, response, id) => {
	const session = sessions.get(id);
	if (!session) {
		sendJson(response, 404, { error: 'unknown_upload' });
		return;
	}

	const range = parseContentRange(request.headers['content-range']);
	if (!range) {
		sendJson(response, 400, { error: 'bad_content_range' });
		return;
	}
	if (range.total !== session.size) {
		sendJson(response, 400, { error: 'size_mismatch' });
		return;
	}
	// Strictly sequential: the client is told where to resume from rather than
	// being trusted to seek, so a chunk can never land at the wrong offset.
	if (range.start !== session.received) {
		sendJson(response, 409, {
			error: 'offset_mismatch',
			expected: session.received,
		});
		return;
	}

	const expected = range.end - range.start + 1;
	session.touched = Date.now();

	try {
		await writeChunk(session, request, expected);
	} catch (error) {
		discardSession(session);
		console.error(`upload ${id} aborted: ${error.message}`);
		if (!response.headersSent) {
			sendJson(response, 400, { error: 'chunk_failed' });
		}
		return;
	}

	session.received += expected;

	// Check what the file actually is as soon as there are enough bytes to
	// tell, so a disguised file is dropped early instead of after a long upload.
	if (!session.checked && session.received >= 12) {
		const head = Buffer.alloc(12);
		const handle = fs.openSync(session.tempPath, 'r');
		try {
			fs.readSync(handle, head, 0, 12, 0);
		} finally {
			fs.closeSync(handle);
		}

		if (!looksLikeItsExtension(session.storedName, head)) {
			discardSession(session);
			sendJson(response, 415, { error: 'content_does_not_match_extension' });
			return;
		}
		session.checked = true;
	}

	if (session.received < session.size) {
		sendJson(response, 200, { received: session.received, complete: false });
		return;
	}

	// Complete: move it out of .incoming under a name that is free
	try {
		const finalPath = claimName(session.storedName);
		fs.renameSync(session.tempPath, finalPath);
		sessions.delete(session.id);
		console.log(`stored ${path.basename(finalPath)} (${session.size} bytes)`);
		sendJson(response, 200, {
			received: session.received,
			complete: true,
			storedAs: path.basename(finalPath),
		});
	} catch (error) {
		discardSession(session);
		console.error(`could not store ${session.storedName}: ${error.message}`);
		sendJson(response, 500, { error: 'could_not_store' });
	}
};

// -------------------------------------------------------------------- server

const handleRequest = async (request, response) => {
	setSecurityHeaders(response);

	const url = request.url || '/';

	if (request.method === 'POST' && url === '/api/upload-session') {
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

		await startSession(request, response);
		return;
	}

	if (request.method === 'PUT' && url.startsWith('/api/upload/')) {
		if (!isOriginAllowed(request.headers.origin)) {
			sendJson(response, 403, { error: 'origin_not_allowed' });
			return;
		}
		const rejection = passcodeRejection(request);
		if (rejection) {
			sendJson(response, rejection[0], rejection[1]);
			return;
		}

		const id = url.slice('/api/upload/'.length);
		if (!/^[0-9a-f-]{36}$/.test(id)) {
			sendJson(response, 404, { error: 'unknown_upload' });
			return;
		}

		await receiveChunk(request, response, id);
		return;
	}

	// Checks a passcode on its own, so the page can tell a guest they are in
	// before they pick any files.
	if (request.method === 'POST' && url === '/api/upload-login') {
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

	// Liveness probe for the Docker healthcheck and the deploy verifier
	if (request.method === 'GET' && url === '/health') {
		sendJson(response, 200, {
			ok: true,
			photos: fs.existsSync(uploadDir),
			usedBytes,
			maxTotalBytes,
			passcodeRequired: Boolean(uploadPasscode),
		});
		return;
	}

	if (request.method === 'GET' && url === '/api/upload-config') {
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

const gigabytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

server.listen(PORT, HOST, () => {
	console.log(`listening on ${HOST}:${PORT}`);
	console.log(`photos saved to ${uploadDir}`);
	console.log(
		`storage: ${gigabytes(usedBytes)} used of ${gigabytes(maxTotalBytes)}, ` +
			`max ${Math.round(maxFileBytes / 1024 / 1024)} MB per file`
	);
	console.log(
		`upload rate limit: ${rateMax} requests / ${rateWindowMs}ms per client`
	);
	console.log(
		allowedOrigins.length
			? `upload origin allowlist: ${allowedOrigins.join(', ')}`
			: 'upload origin allowlist: off (ALLOWED_ORIGINS not set)'
	);
	console.log(
		uploadPasscode
			? `upload passcode: required (${PASSCODE_MAX_FAILURES} wrong guesses locks a client out for ${PASSCODE_LOCKOUT_MS / 60000} minutes)`
			: 'upload passcode: NOT SET - anyone who can load the site can upload'
	);

	if (!uploadDir.startsWith('/data')) {
		return;
	}
	try {
		fs.accessSync(uploadDir, fs.constants.W_OK);
	} catch {
		console.log('');
		console.log(`WARNING: ${uploadDir} is not writable.`);
		console.log('On CapRover, add /data under Persistent Directories.');
		console.log('');
	}
});

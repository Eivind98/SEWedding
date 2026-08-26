'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
	MS_CLIENT_ID,
	MS_CLIENT_SECRET,
	MS_REFRESH_TOKEN,
	ONEDRIVE_FOLDER = 'Brudleyp/Myndir',
	TOKEN_FILE = '/data/refresh_token',
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
};

// Microsoft rotates the refresh token on every use, and CapRover restarts the
// container on every deploy, so the current one has to outlive the process.
const readRefreshToken = () => {
	try {
		const stored = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
		if (stored) {
			return stored;
		}
	} catch {
		// no stored token yet, fall through to the seed value
	}
	return clean(MS_REFRESH_TOKEN);
};

const saveRefreshToken = (token) => {
	try {
		fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
		fs.writeFileSync(TOKEN_FILE, token);
	} catch (error) {
		console.error('could not persist refresh token:', error.message);
	}
};

let accessToken = null;
let accessTokenExpiry = 0;

const getAccessToken = async () => {
	if (accessToken && Date.now() < accessTokenExpiry) {
		return accessToken;
	}

	const response = await fetch(
		'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
		{
			method: 'POST',
			body: new URLSearchParams({
				client_id: clean(MS_CLIENT_ID),
				client_secret: clean(MS_CLIENT_SECRET),
				refresh_token: readRefreshToken(),
				grant_type: 'refresh_token',
			}),
		}
	);

	if (!response.ok) {
		throw new Error(`token refresh failed: ${await response.text()}`);
	}

	const token = await response.json();
	accessToken = token.access_token;
	accessTokenExpiry = Date.now() + (token.expires_in - 300) * 1000;
	if (token.refresh_token) {
		saveRefreshToken(token.refresh_token);
	}
	return accessToken;
};

// Guests choose the file name, so strip anything that escapes the folder or
// that OneDrive rejects outright.
const safeName = (name) =>
	String(name || '')
		.split(/[\/]/)
		.pop()
		.replace(/["*:<>?|]/g, '_')
		.replace(/^\.+/, '')
		.slice(-180) || 'mynd';

const createUploadSession = async (name) => {
	const token = await getAccessToken();
	const itemPath = `${ONEDRIVE_FOLDER}/${safeName(name)}`
		.split('/')
		.map(encodeURIComponent)
		.join('/');

	const response = await fetch(
		`https://graph.microsoft.com/v1.0/me/drive/root:/${itemPath}:/createUploadSession`,
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
		throw new Error(`createUploadSession failed: ${await response.text()}`);
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

const serveStatic = (request, response) => {
	const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
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

const server = http.createServer(async (request, response) => {
	if (request.method === 'POST' && request.url === '/api/upload-session') {
		try {
			const { name } = JSON.parse(await readBody(request));
			const session = await createUploadSession(name);
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ uploadUrl: session.uploadUrl }));
		} catch (error) {
			console.error(error);
			response.writeHead(502, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: 'upload_session_failed' }));
		}
		return;
	}

	if (request.method === 'GET' || request.method === 'HEAD') {
		serveStatic(request, response);
		return;
	}

	response.writeHead(405).end('Method not allowed');
});

const missing = Object.entries({
	MS_CLIENT_ID,
	MS_CLIENT_SECRET,
	MS_REFRESH_TOKEN,
})
	.filter(([, value]) => !clean(value))
	.map(([key]) => key);

server.listen(PORT, HOST, () => {
	console.log(`listening on ${HOST}:${PORT}`);
	if (missing.length) {
		console.log('');
		console.log(`WARNING: uploads are disabled - missing ${missing.join(', ')}`);
		console.log('The site will serve, but /api/upload-session will fail.');
		console.log('Run `node get-refresh-token.js` to create a .env.');
		console.log('');
	}
});

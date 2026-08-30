'use strict';

// One-time setup: signs you in, then writes a local .env you can test against
// and paste into CapRover. Run with `node get-refresh-token.js`.

const http = require('node:http');
const fs = require('node:fs');
const readline = require('node:readline/promises');

const REDIRECT_URI = 'http://localhost:3000/callback';
// Files.ReadWrite.AppFolder, not Files.ReadWrite: the grant is confined to one
// dedicated folder Microsoft creates for this app. A leaked client secret and
// refresh token together still cannot read or touch the rest of the OneDrive.
const SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const ENV_FILE = '.env';
const NL = String.fromCharCode(10);

const main = async () => {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	if (fs.existsSync(ENV_FILE)) {
		const answer = await rl.question(`${ENV_FILE} already exists. Overwrite? [y/N] `);
		if (answer.trim().toLowerCase() !== 'y') {
			rl.close();
			console.log('Cancelled.');
			return;
		}
	}

	const clientId = (await rl.question('Application (client) ID: ')).trim();
	const clientSecret = (await rl.question('Client secret VALUE: ')).trim();
	// Relative to the app folder now, not to the drive root
	const folder =
		(await rl.question('Folder inside the app folder [Myndir]: ')).trim() ||
		'Myndir';
	// The shared code guests read off the invitation. Blank leaves uploads open
	// to anyone who can load the site, which is a choice, not a default.
	const passcode = (
		await rl.question('Upload passcode for guests (blank = no code): ')
	).trim();
	rl.close();

	const authUrl =
		'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?' +
		new URLSearchParams({
			client_id: clientId,
			response_type: 'code',
			redirect_uri: REDIRECT_URI,
			response_mode: 'query',
			scope: SCOPE,
		});

	console.log('\nOpen this URL in your browser and sign in:\n');
	console.log(authUrl);
	console.log('\nWaiting for the redirect...');

	const code = await new Promise((resolve, reject) => {
		const server = http.createServer((request, response) => {
			const url = new URL(request.url, 'http://localhost:3000');
			if (url.pathname !== '/callback') {
				response.writeHead(404).end();
				return;
			}
			const error = url.searchParams.get('error_description');
			response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end(error || 'Done. You can close this tab.');
			server.close();
			return error
				? reject(new Error(error))
				: resolve(url.searchParams.get('code'));
		});
		server.listen(3000);
	});

	const response = await fetch(
		'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
		{
			method: 'POST',
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: REDIRECT_URI,
				grant_type: 'authorization_code',
			}),
		}
	);

	if (!response.ok) {
		throw new Error(await response.text());
	}

	const token = await response.json();

	const envLines = [
		`MS_CLIENT_ID=${clientId}`,
		`MS_CLIENT_SECRET=${clientSecret}`,
		`MS_REFRESH_TOKEN=${token.refresh_token}`,
		`ONEDRIVE_FOLDER=${folder}`,
		...(passcode ? [`UPLOAD_PASSCODE=${passcode}`] : []),
		'TOKEN_FILE=.refresh_token',
	];

	fs.writeFileSync(ENV_FILE, envLines.join(NL) + NL);

	console.log(`${NL}Wrote ${ENV_FILE}. Check it with:${NL}`);
	console.log('  npm run check');
	console.log('  npm run serve' + NL);

	// TOKEN_FILE is deliberately left out of the CapRover block: the container
	// keeps its rotated token on the /data volume, and pasting a relative path
	// would send it to the container filesystem instead, losing it on redeploy.
	console.log('For CapRover, paste these into App Configs -> Environmental');
	console.log('Variables -> Bulk Edit:' + NL);
	console.log(
		envLines.filter((line) => !line.startsWith('TOKEN_FILE=')).join(NL)
	);
};

main().catch((error) => {
	console.error('\nFailed:', error.message);
	// exitCode rather than exit(): lets open sockets close cleanly on Windows
	process.exitCode = 1;
});

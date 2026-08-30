'use strict';

// Preflight for the OneDrive relay. Confirms the credentials in .env actually
// work, shows which account they belong to, and creates the destination folder
// if it does not exist yet. Run with `npm run check`.

const {
	MS_CLIENT_ID,
	MS_CLIENT_SECRET,
	MS_REFRESH_TOKEN,
	// Same default as server.js, so the two never disagree about the destination
	ONEDRIVE_FOLDER = 'Myndir',
} = process.env;

const GRAPH = 'https://graph.microsoft.com/v1.0';
// The token is scoped to the app folder, so this is as far up as it can see
const APP_FOLDER = `${GRAPH}/me/drive/special/approot`;

// A .env saved with Windows CRLF endings leaves a carriage return on
// every value, which Microsoft rejects
const clean = (value) => String(value || '').trim();

const getAccessToken = async () => {
	const response = await fetch(
		'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
		{
			method: 'POST',
			body: new URLSearchParams({
				client_id: clean(MS_CLIENT_ID),
				client_secret: clean(MS_CLIENT_SECRET),
				refresh_token: clean(MS_REFRESH_TOKEN),
				grant_type: 'refresh_token',
			}),
		}
	);
	if (!response.ok) {
		throw new Error(await response.text());
	}
	return (await response.json()).access_token;
};

const encodePath = (value) =>
	value.split('/').map(encodeURIComponent).join('/');

const ensureFolder = async (token, folderPath) => {
	const auth = { Authorization: `Bearer ${token}` };
	let parent = '';

	for (const segment of folderPath.split('/').filter(Boolean)) {
		const current = parent ? `${parent}/${segment}` : segment;
		const probe = await fetch(`${APP_FOLDER}:/${encodePath(current)}`, {
			headers: auth,
		});

		if (probe.ok) {
			console.log(`  exists   /${current}`);
		} else if (probe.status === 404) {
			const parentUrl = parent
				? `${APP_FOLDER}:/${encodePath(parent)}:/children`
				: `${APP_FOLDER}/children`;
			const created = await fetch(parentUrl, {
				method: 'POST',
				headers: { ...auth, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: segment,
					folder: {},
					'@microsoft.graph.conflictBehavior': 'fail',
				}),
			});
			if (!created.ok) {
				throw new Error(`could not create /${current}: ${await created.text()}`);
			}
			console.log(`  created  /${current}`);
		} else {
			throw new Error(`could not read /${current}: ${await probe.text()}`);
		}

		parent = current;
	}
};

const gigabytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const main = async () => {
	for (const [key, value] of Object.entries({
		MS_CLIENT_ID,
		MS_CLIENT_SECRET,
		MS_REFRESH_TOKEN,
	})) {
		if (!value) {
			throw new Error(`${key} is not set - run: node get-refresh-token.js`);
		}
	}

	console.log('Refreshing access token...');
	const token = await getAccessToken();
	console.log('  ok\n');

	console.log('Reading the app folder...');
	const rootResponse = await fetch(APP_FOLDER, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!rootResponse.ok) {
		throw new Error(await rootResponse.text());
	}
	const appFolder = await rootResponse.json();
	console.log(`  path     ${appFolder.parentReference?.path ?? ''}/${appFolder.name}`);

	// Drive-wide quota needs a drive-wide scope, which is exactly what this app
	// no longer asks for. Report it when it happens to be readable, never fail.
	const driveResponse = await fetch(`${GRAPH}/me/drive`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (driveResponse.ok) {
		const drive = await driveResponse.json();
		if (drive.quota?.total) {
			console.log(
				`  space    ${gigabytes(drive.quota.remaining)} free of ${gigabytes(drive.quota.total)}`
			);
		}
	} else {
		console.log('  space    not visible under the app-folder scope');
	}
	console.log('');

	console.log(`Checking folder ${clean(ONEDRIVE_FOLDER)}...`);
	await ensureFolder(token, clean(ONEDRIVE_FOLDER));

	console.log('\nReady. Start the site with: npm run serve');
};

main().catch((error) => {
	console.error('\nFailed:', error.message);
	// exitCode rather than exit(): lets open sockets close cleanly on Windows
	process.exitCode = 1;
});

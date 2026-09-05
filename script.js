document.getElementById('year').textContent = new Date().getFullYear();

// Language switching functionality
class LanguageSwitcher {
	constructor() {
		this.currentLang = localStorage.getItem('selectedLanguage') || 'fo';
		this.init();
	}

	init() {
		this.setLanguage(this.currentLang);
		this.bindEvents();
		this.updateToggleButton();
	}

	bindEvents() {
		const toggleButton = document.getElementById('language-toggle');
		if (toggleButton) {
			toggleButton.addEventListener('click', () => {
				const newLang = this.currentLang === 'fo' ? 'da' : 'fo';
				this.setLanguage(newLang);
			});
		}
	}

	setLanguage(lang) {
		this.currentLang = lang;
		localStorage.setItem('selectedLanguage', lang);
		
		// Update all elements with data attributes
		document.querySelectorAll('[data-fo][data-da]').forEach(element => {
			const text = element.getAttribute(`data-${lang}`);
			if (text) {
				element.textContent = text;
			}
		});

		// Update page title
		const title = document.querySelector('title');
		if (title) {
			const titleText = title.getAttribute(`data-${lang}`);
			if (titleText) {
				title.textContent = titleText;
			}
		}

		// Update HTML lang attribute
		document.documentElement.lang = lang;
		
		// Update toggle button appearance
		this.updateToggleButton();
	}

	updateToggleButton() {
		const button = document.getElementById('language-toggle');
		if (button) {
			button.classList.toggle('active-fo', this.currentLang === 'fo');
			button.classList.toggle('active-da', this.currentLang === 'da');
		}
	}
}

// Initialize language switcher
new LanguageSwitcher();

const siteNav = document.querySelector('.site-nav');
const navToggle = document.querySelector('.site-nav__toggle');
const navPanel = document.getElementById('site-nav-panel');

if (siteNav && navToggle && navPanel) {
	const navLinks = navPanel.querySelectorAll('a[href^="#"]');

	const closeNav = () => {
		siteNav.classList.remove('site-nav--open');
		navToggle.setAttribute('aria-expanded', 'false');
	};

	navToggle.addEventListener('click', () => {
		const isOpen = siteNav.classList.toggle('site-nav--open');
		navToggle.setAttribute('aria-expanded', String(isOpen));
	});

	navLinks.forEach((link) => {
		link.addEventListener('click', () => {
			if (window.innerWidth < 768) {
				closeNav();
			}
		});
	});

	window.addEventListener('resize', () => {
		if (window.innerWidth >= 768) {
			closeNav();
		}
	});

	document.addEventListener('click', (event) => {
		if (
			siteNav.classList.contains('site-nav--open') &&
			!siteNav.contains(event.target)
		) {
			closeNav();
		}
	});
}

// Photo upload -> saved on the server
const uploadDrop = document.getElementById('upload-drop');
const uploadInput = document.getElementById('upload-input');
const uploadPick = document.getElementById('upload-pick');
const uploadList = document.getElementById('upload-list');
const passcodeBlock = document.getElementById('upload-passcode');
const passcodeField = document.getElementById('upload-passcode-input');
const passcodeButton = document.getElementById('upload-passcode-button');
const passcodeError = document.getElementById('upload-passcode-error');
const statusLine = document.getElementById('upload-status');

if (uploadDrop && uploadInput && uploadPick && uploadList) {
	const CHUNK_SIZE = 10 * 1024 * 1024; // must be a multiple of 320 KiB
	const PASSCODE_KEY = 'uploadPasscode';
	const queue = [];
	let running = false;
	// The code that goes out with every upload request. Empty until the guest
	// logs in, or when the relay is not asking for one.
	let passcode = '';

	// Setting both data attributes lets LanguageSwitcher retranslate on toggle
	const setText = (element, fo, da) => {
		element.setAttribute('data-fo', fo);
		element.setAttribute('data-da', da);
		element.textContent = document.documentElement.lang === 'da' ? da : fo;
	};

	// ---- Logging in -------------------------------------------------------
	// The drop zone stays out of sight until the passcode is accepted, so it is
	// never ambiguous whether the page is ready to take photos.

	const showLogin = () => {
		if (passcodeBlock) {
			passcodeBlock.hidden = false;
		}
		if (statusLine) {
			statusLine.hidden = true;
		}
		uploadDrop.hidden = true;
	};

	const showReady = () => {
		if (passcodeBlock) {
			passcodeBlock.hidden = true;
		}
		if (statusLine) {
			setText(statusLine, 'Innritað - tú kanst leggja myndir upp', 'Logget ind - du kan uploade billeder');
			statusLine.hidden = false;
		}
		uploadDrop.hidden = false;
	};

	const showMessage = (fo, da) => {
		if (passcodeError) {
			setText(passcodeError, fo, da);
			passcodeError.hidden = false;
		}
	};

	// silent: a remembered passcode is retried on load, and a stale one should
	// not greet the guest with a red error before they have touched anything.
	const logIn = async (candidate, { silent = false } = {}) => {
		if (!candidate) {
			return false;
		}

		if (passcodeButton) {
			passcodeButton.disabled = true;
			setText(passcodeButton, 'Kannar...', 'Tjekker...');
		}

		let ok = false;
		try {
			const response = await fetch('/api/upload-login', {
				method: 'POST',
				headers: { 'X-Upload-Passcode': candidate },
			});

			if (response.ok) {
				passcode = candidate;
				try {
					localStorage.setItem(PASSCODE_KEY, candidate);
				} catch {
					// storage blocked: the passcode still works for this visit
				}
				ok = true;
			} else if (response.status === 429) {
				showMessage(
					'Ov nógvar royndir. Bíða 5 minuttir.',
					'For mange forsøg. Vent 5 minutter.'
				);
			} else if (!silent) {
				showMessage('Kodan er skeiv, prøva umaftur', 'Forkert kode. Prøv igen.');
			}
		} catch {
			if (!silent) {
				showMessage(
					'Fekk ikki samband. Royn aftur.',
					'Ingen forbindelse. Prøv igen.'
				);
			}
		}

		if (passcodeButton) {
			passcodeButton.disabled = false;
			setText(passcodeButton, 'Innrita', 'Log ind');
		}

		if (ok) {
			showReady();
			run(); // anything already queued carries on
		}
		return ok;
	};

	if (passcodeField && passcodeButton) {
		const submit = () => logIn(passcodeField.value.trim());

		passcodeButton.addEventListener('click', submit);
		passcodeField.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				submit();
			}
		});
		passcodeField.addEventListener('input', () => {
			if (passcodeError) {
				passcodeError.hidden = true;
			}
		});
	}

	// Ask the relay whether a passcode is wanted at all before showing anything
	uploadDrop.hidden = true;
	fetch('/api/upload-config')
		.then((response) => (response.ok ? response.json() : null))
		.then((config) => {
			if (!config || !config.passcodeRequired) {
				showReady();
				if (statusLine) {
					statusLine.hidden = true; // nothing to log in to
				}
				return;
			}

			showLogin();

			let remembered = '';
			try {
				remembered = localStorage.getItem(PASSCODE_KEY) || '';
			} catch {
				// no storage: the guest simply types it again
			}
			if (remembered) {
				if (passcodeField) {
					passcodeField.value = remembered;
				}
				logIn(remembered, { silent: true });
			}
		})
		.catch(() => {
			// The probe failed - show the drop zone rather than blocking uploads
			// behind a check that never answered.
			showReady();
			if (statusLine) {
				statusLine.hidden = true;
			}
		});

	const addItem = (file) => {
		const li = document.createElement('li');
		li.className = 'upload-item';

		const row = document.createElement('div');
		row.className = 'upload-item__row';

		const name = document.createElement('span');
		name.className = 'upload-item__name';
		name.textContent = file.name;

		const state = document.createElement('span');
		state.className = 'upload-item__state';
		setText(state, 'Bíðar', 'Venter');

		row.append(name, state);

		const bar = document.createElement('div');
		bar.className = 'upload-item__bar';
		const fill = document.createElement('span');
		fill.className = 'upload-item__fill';
		bar.append(fill);

		li.append(row, bar);
		uploadList.append(li);
		return { li, state, fill };
	};

	// Every response the server can refuse an upload with, turned into flags
	// the queue knows how to act on.
	const describeFailure = (status, error) => {
		error.rejectedType = status === 415;
		error.rejectedPasscode = status === 401;
		error.lockedOut = status === 429;
		error.tooLarge = status === 413;
		error.storageFull = status === 507;
		return error;
	};

	const uploadFile = async (file, ui) => {
		const response = await fetch('/api/upload-session', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				// Header rather than query string: a passcode has no business
				// sitting in a URL, where it lands in logs and history
				'X-Upload-Passcode': passcode,
			},
			body: JSON.stringify({ name: file.name, size: file.size }),
		});
		if (!response.ok) {
			// The accept attribute is a filter, not a guarantee - a drop, or a
			// file picker set to "all files", still reaches the server, which
			// only starts an upload for image and video extensions.
			throw describeFailure(
				response.status,
				new Error(`upload session failed: ${response.status}`)
			);
		}

		const { id, chunkSize } = await response.json();
		const size = chunkSize || CHUNK_SIZE;

		// The server writes strictly sequentially and tells us where it got to,
		// so a dropped chunk is retried from the offset it reports rather than
		// restarting the whole file.
		let start = 0;
		while (start < file.size) {
			const end = Math.min(start + size, file.size);
			const chunk = await fetch(`/api/upload/${id}`, {
				method: 'PUT',
				headers: {
					'Content-Range': `bytes ${start}-${end - 1}/${file.size}`,
					'X-Upload-Passcode': passcode,
				},
				body: file.slice(start, end),
			});

			if (!chunk.ok) {
				if (chunk.status === 409) {
					// We disagree about the offset - carry on from the server's
					const { expected } = await chunk.json().catch(() => ({}));
					if (Number.isInteger(expected) && expected < file.size) {
						start = expected;
						continue;
					}
				}
				throw describeFailure(
					chunk.status,
					new Error(`chunk failed: ${chunk.status}`)
				);
			}

			start = end;
			ui.fill.style.width = `${Math.round((start / file.size) * 100)}%`;
		}
	};

	const run = async () => {
		if (running) {
			return;
		}
		running = true;
		while (queue.length) {
			const { file, ui } = queue[0];
			setText(ui.state, 'Sendir', 'Sender');
			try {
				await uploadFile(file, ui);
				queue.shift();
				ui.li.classList.add('upload-item--done');
				ui.fill.style.width = '100%';
				setText(ui.state, 'Liðugt', 'Færdig');
			} catch (error) {
				console.error(error);

				// The passcode stopped working mid-batch - it was changed on the
				// server, or this client hit the lockout. Not this file's
				// fault, so leave the queue standing, ask for it again, and let
				// logging back in carry on with the same photos.
				if (error.rejectedPasscode || error.lockedOut) {
					passcode = '';
					showLogin();
					if (error.lockedOut) {
						showMessage(
							'Ov nógvar royndir. Bíða 5 minuttir.',
							'For mange forsøg. Vent 5 minutter.'
						);
					} else {
						showMessage('Kodan er skeiv, prøva umaftur', 'Forkert kode. Prøv igen.');
						if (passcodeField) {
							passcodeField.focus();
						}
					}
					for (const pending of queue) {
						setText(pending.ui.state, 'Bíðar eftir kodu', 'Venter på kode');
					}
					running = false;
					return;
				}

				queue.shift();
				ui.li.classList.add('upload-item--error');
				if (error.rejectedType) {
					setText(ui.state, 'Bara myndir og filmar', 'Kun billeder og film');
				} else if (error.tooLarge) {
					setText(ui.state, 'Fílan er ov stór', 'Filen er for stor');
				} else if (error.storageFull) {
					setText(ui.state, 'Ikki meira pláss', 'Ikke mere plads');
				} else {
					setText(ui.state, 'Miseydnaðist', 'Mislykkedes');
				}
			}
		}
		running = false;
	};

	const addFiles = (files) => {
		for (const file of files) {
			if (file.size) {
				queue.push({ file, ui: addItem(file) });
			}
		}
		run();
	};

	uploadPick.addEventListener('click', () => uploadInput.click());

	uploadInput.addEventListener('change', () => {
		addFiles(uploadInput.files);
		uploadInput.value = '';
	});

	['dragenter', 'dragover'].forEach((type) => {
		uploadDrop.addEventListener(type, (event) => {
			event.preventDefault();
			uploadDrop.classList.add('upload-drop--over');
		});
	});

	['dragleave', 'drop'].forEach((type) => {
		uploadDrop.addEventListener(type, (event) => {
			event.preventDefault();
			uploadDrop.classList.remove('upload-drop--over');
		});
	});

	uploadDrop.addEventListener('drop', (event) => {
		if (event.dataTransfer) {
			addFiles(event.dataTransfer.files);
		}
	});

	// Keep the browser from opening files dropped outside the zone
	window.addEventListener('dragover', (event) => event.preventDefault());
	window.addEventListener('drop', (event) => event.preventDefault());

	window.addEventListener('beforeunload', (event) => {
		if (running) {
			event.preventDefault();
		}
	});
}

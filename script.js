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

// Photo upload -> OneDrive relay
const uploadDrop = document.getElementById('upload-drop');
const uploadInput = document.getElementById('upload-input');
const uploadPick = document.getElementById('upload-pick');
const uploadList = document.getElementById('upload-list');

if (uploadDrop && uploadInput && uploadPick && uploadList) {
	const CHUNK_SIZE = 10 * 1024 * 1024; // must be a multiple of 320 KiB
	const queue = [];
	let running = false;

	// Setting both data attributes lets LanguageSwitcher retranslate on toggle
	const setText = (element, fo, da) => {
		element.setAttribute('data-fo', fo);
		element.setAttribute('data-da', da);
		element.textContent = document.documentElement.lang === 'da' ? da : fo;
	};

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

	const uploadFile = async (file, ui) => {
		const response = await fetch('/api/upload-session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: file.name }),
		});
		if (!response.ok) {
			throw new Error(`upload session failed: ${response.status}`);
		}
		const { uploadUrl } = await response.json();

		// The upload URL is pre-authenticated: never send an Authorization header
		let start = 0;
		while (start < file.size) {
			const end = Math.min(start + CHUNK_SIZE, file.size);
			const chunk = await fetch(uploadUrl, {
				method: 'PUT',
				headers: {
					'Content-Range': `bytes ${start}-${end - 1}/${file.size}`,
				},
				body: file.slice(start, end),
			});
			if (!chunk.ok) {
				throw new Error(`chunk failed: ${chunk.status}`);
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
			const { file, ui } = queue.shift();
			setText(ui.state, 'Sendir', 'Sender');
			try {
				await uploadFile(file, ui);
				ui.li.classList.add('upload-item--done');
				ui.fill.style.width = '100%';
				setText(ui.state, 'Liðugt', 'Færdig');
			} catch (error) {
				console.error(error);
				ui.li.classList.add('upload-item--error');
				setText(ui.state, 'Miseydnaðist', 'Mislykkedes');
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

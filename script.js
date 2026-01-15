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
document.getElementById('year').textContent = new Date().getFullYear();

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
// Shared top navigation for the dashboard (/) and the API docs (/docs), so reviewers can move between them.
// Loaded by index.html and injected into the Swagger UI page by src/app.js. No dependencies.
(() => {
  const REPO_URL = 'https://github.com/pranjalkumaraug2003-ops/Urja_API';
  const LINKS = [
    { href: '/', label: 'Dashboard' },
    { href: '/docs', label: 'API docs' },
    { href: '/openapi.json', label: 'OpenAPI JSON', external: true },
    { href: '/health', label: 'Health', external: true },
    { href: REPO_URL, label: 'GitHub', external: true },
  ];

  function build() {
    if (document.querySelector('.site-nav')) return;
    const nav = document.createElement('nav');
    nav.className = 'site-nav';
    nav.setAttribute('aria-label', 'Site');

    const brand = document.createElement('a');
    brand.className = 'brand';
    brand.href = '/';
    const mark = document.createElement('span');
    mark.className = 'brand-mark';
    brand.append(mark, document.createTextNode('Urja Meter Ops API'));
    nav.append(brand);

    const here = location.pathname.replace(/\/+$/, '') || '/';
    for (const { href, label, external } of LINKS) {
      const a = document.createElement('a');
      a.className = 'link';
      a.href = href;
      a.textContent = label;
      if (external) {
        a.target = '_blank';
        a.rel = 'noopener';
      }
      if (href === here || (href === '/docs' && here.startsWith('/docs'))) {
        a.classList.add('active');
        a.setAttribute('aria-current', 'page');
      }
      nav.append(a);
    }

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const status = document.createElement('span');
    status.className = 'status';
    status.title = 'From GET /health';
    const dot = document.createElement('i');
    const text = document.createElement('span');
    text.textContent = 'checking service...';
    status.append(dot, text);
    nav.append(spacer, status);

    document.body.prepend(nav);
    refreshStatus(status, text);
    setInterval(() => refreshStatus(status, text), 60_000);
  }

  async function refreshStatus(status, text) {
    try {
      const health = await (await fetch('/health')).json();
      status.className = `status ${health.status}`;
      const when = health.cache.meters.fetchedAt ? new Date(health.cache.meters.fetchedAt).toLocaleTimeString() : 'not loaded yet';
      text.textContent = `${health.status} · ${health.cache.meters.count} meters · data from ${when}`;
    } catch {
      status.className = 'status';
      text.textContent = 'service unreachable';
    }
  }

  // Exposed so the dashboard can refresh the status right after its first load fills the cache.
  window.refreshSiteStatus = () => {
    const status = document.querySelector('.site-nav .status');
    if (status) refreshStatus(status, status.querySelector('span'));
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();

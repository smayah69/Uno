// Vercel Web Analytics (page views, cookieless). The script only exists on
// Vercel deployments, so skip it locally and in ?local=1 test mode.
const local = /^(localhost|127\.|\[::1\])/.test(location.hostname) || new URLSearchParams(location.search).has('local');
if (!local) {
  window.va = window.va || function va(...args) { (window.vaq = window.vaq || []).push(args); };
  const s = document.createElement('script');
  s.defer = true;
  s.src = '/_vercel/insights/script.js';
  document.head.append(s);
}

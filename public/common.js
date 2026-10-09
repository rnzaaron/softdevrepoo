// Shared browser helper, loaded by every page except sign-in. It supplies the design,
// safe display helpers, server requests, and the navigation menu used throughout the site.
// The CSS below is one long template string (backticks let it span a large text value).
const CSS = `:root{color-scheme:light;--forest:#123d31;--green:#176b4a;--leaf:#2c8b61;--mint:#e4f2e9;--ink:#1d2c25;--muted:#687970;--line:#dce7df;--paper:#f4f8f4}*{box-sizing:border-box}body{margin:0;font:15px/1.5 'Trebuchet MS',Verdana,sans-serif;background:var(--paper);color:var(--ink);display:flex;min-height:100vh}#nav{width:248px;flex:none;min-height:100vh;background:var(--forest);color:#f3fff5;padding:22px 16px;box-sizing:border-box}#nav .brand{padding:4px 10px 20px;border-bottom:1px solid #ffffff26;margin-bottom:15px}#nav .brand strong{display:block;font-size:16px;line-height:1.25}#nav .brand small{color:#afd1bc}#nav a{display:block;color:#e0f0e4;padding:9px 11px;margin:3px 0;text-decoration:none;border-radius:5px}#nav a:hover,#nav a.active{background:#ffffff1b;color:#fff}#nav .logout{margin-top:18px;color:#cbe2d1}main{flex:1;padding:28px 34px;overflow-x:auto;max-width:1500px}h1,h2,h3{color:var(--forest);margin-top:0}h1{font-size:27px;margin-bottom:5px}h2{font-size:22px}h3{font-size:17px}.subhead{color:var(--muted);margin:0 0 22px}.card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:17px;margin:0 0 15px;box-shadow:0 2px 8px #173a2810}.cards{display:flex;gap:13px;flex-wrap:wrap}.cards .card{flex:1;min-width:155px}.metric{font-size:28px;font-weight:700;color:var(--green)}table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid var(--line);padding:10px 9px;text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;background:#f7faf7}button,.button{background:var(--green);color:#fff;border:0;border-radius:4px;padding:9px 13px;cursor:pointer;margin:3px 3px 3px 0;font:inherit}button:hover,.button:hover{background:var(--forest)}button.secondary{background:#eaf3ed;color:var(--forest)}button.danger{background:#a84036}input,select,textarea{padding:9px;margin:4px 5px 6px 0;border:1px solid #bdcec2;border-radius:4px;font:inherit;max-width:100%}textarea{min-width:min(340px,100%)}label{font-size:13px;font-weight:600;color:#355344}.field{display:inline-grid;gap:3px;margin:4px 9px 7px 0;vertical-align:top}.badge{display:inline-block;padding:3px 8px;border-radius:12px;background:var(--mint);color:#18553b;font-size:12px;font-weight:700}.err{color:#a52a24}.notice{padding:10px 12px;background:#fff4d9;border-left:3px solid #c6922a;margin:8px 0}.muted{color:var(--muted)}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.empty{padding:20px;color:var(--muted);text-align:center}@media(max-width:760px){body{display:block}#nav{width:100%;min-height:0;padding:12px}#nav .brand{padding:5px 8px 10px;margin-bottom:8px}#nav a{display:inline-block;padding:7px 9px;margin:2px}main{padding:20px 13px}.cards .card{min-width:calc(50% - 10px)}}`;

// The login page saves this JSON user profile here; no value means the person is signed out.
const user = JSON.parse(localStorage.user || 'null');   // saved at login

// api('path', 'POST', {data}) sends a request to the backend and returns its JSON reply.
// `await` pauses this page until the server answers; a failed request throws an error instead.
async function api(path, method = 'GET', body) {
  const r = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json', token: localStorage.token || '' },
    body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw { error: `The server returned an invalid response for /api/${path} (HTTP ${r.status}). Check the server log.` }; }
  if (!r.ok) throw data || { error: `The request failed with HTTP ${r.status}.` };
  if (data === null) throw { error: `The server returned an empty response for /api/${path} (HTTP ${r.status}). Check that the app and MongoDB are running.` };
  return data;
}
// Escape user-provided text before placing it in HTML, reducing accidental/bad markup.
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const badge = s => `<span class="badge">${esc(s)}</span>`;
// init('Page title'): send signed-out visitors to login; otherwise build the shared menu.
function init(title) {
  if (!user) { location = 'index.html'; return; }
  document.head.insertAdjacentHTML('beforeend', '<style>' + CSS + '</style><meta name=viewport content="width=device-width,initial-scale=1">');
  const links = [['dashboard.html', 'Dashboard'], ['grades.html', 'Grades'], ['schedule.html', 'Class schedule'], ['announcements.html', 'Announcements']];
  if (['admin', 'adviser', 'student', 'parent'].includes(user.role)) links.push(['reports.html', 'Report cards']);
  if (['admin', 'adviser', 'student', 'parent'].includes(user.role)) links.push(['requests.html', 'Document requests']);
  if (user.role === 'admin') links.push(['admin.html', 'Administration']);
  document.getElementById('nav').innerHTML = `<div class="brand"><strong>ST. CATHERINE COLLEGE</strong><small>Valenzuela City</small></div><div style="padding:8px 10px 12px"><b>${esc(user.name)}</b><br><small>${esc(user.role)}</small></div>` +
    links.map(([href, label]) => `<a href="${href}"${location.pathname.endsWith(href) ? ' class="active"' : ''}>${label}</a>`).join('') + '<a class="logout" href="#" onclick="logout();return false">Sign out</a>';
  document.getElementById('title').textContent = title;
}
// Clear saved login details only after the person confirms they want to sign out.
function logout() { if (confirm('Log out?')) { localStorage.clear(); location = 'index.html'; } }   // confirmation dialog

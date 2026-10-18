'use strict';
// Mock-HubSpot fuer Integration-Tests. Intercept-Fetch fuer HUBSPOT_BASE,
// gesteuerte Posts/Authors/Blogs/Drafts. Stellt sich als globalThis.fetch in den
// Weg und filtert nur HubSpot-URLs; alle anderen Requests gehen durch.
//
// Jeder Post hat einen Draft-Buffer (`state.drafts[id]`) mit eigenem
// `updated`-Stempel — genau den liest die Push-Vorab-Pruefung. Helfer:
//   editDraft(id)   Draft drueben aendern (Stempel springt vor)
//   deletePost(id)  Post drueben loeschen (GET/PATCH → 404)
//   publish(id)     Post drueben publizieren (state + url)

const { HUBSPOT_BASE } = require('../../../lib/hubspot-client');

function makeMock() {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const tick = () => new Date(clock += 1000).toISOString();

  const state = {
    me: { portalId: 4242, accountType: 'STANDARD' },
    authors: [
      { id: '111', fullName: 'Autor Eins', email: 'a1@example.com' },
      { id: '222', fullName: 'Autor Zwei', email: null },
    ],
    blogs: [
      { id: '555', name: 'Mein Blog' },
    ],
    posts: [],          // GET /cms/v3/blogs/posts liefert das hier (Import)
    created: [],        // POST /cms/v3/blogs/posts schiebt rein
    updated: [],        // PATCH /cms/v3/blogs/posts/{id}/draft schiebt rein
    drafts: {},         // id → Draft-Buffer
    deleted: new Set(),
    files: [],          // POST /files/v3/files
    calls: [],
    failOnCreate: false,
  };

  const findPost = (id) => state.created.find(p => p.id === id) || state.posts.find(p => p.id === id);

  const original = globalThis.fetch;
  globalThis.fetch = async function (url, opts = {}) {
    const u = typeof url === 'string' ? url : url.toString();
    if (!u.startsWith(HUBSPOT_BASE)) return original(url, opts);
    const path = u.slice(HUBSPOT_BASE.length).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    state.calls.push({ method, path, url: u });

    if (path === '/account-info/v3/details' && method === 'GET') {
      return jsonResponse(state.me);
    }
    if (path === '/cms/v3/blogs/authors' && method === 'GET') {
      return jsonResponse({ results: state.authors, paging: {} });
    }
    if (path === '/cms/v3/blog-settings/settings' && method === 'GET') {
      return jsonResponse({ results: state.blogs, total: state.blogs.length, paging: {} });
    }
    if (path === '/cms/v3/blogs/posts' && method === 'GET') {
      return jsonResponse({ results: state.posts, paging: {} });
    }
    if (path === '/cms/v3/blogs/posts' && method === 'POST') {
      if (state.failOnCreate) return new Response('boom', { status: 500 });
      const body = JSON.parse(opts.body || '{}');
      const id = String(900000 + state.created.length + 1);
      const now = tick();
      const created = { id, ...body, created: now, updated: now };
      state.created.push(created);
      state.drafts[id] = { ...created };
      return jsonResponse(created);
    }
    if (path === '/files/v3/files' && method === 'POST') {
      const id = String(7000 + state.files.length + 1);
      const name = opts.body?.get?.('fileName') || 'upload.bin';
      state.files.push({ id, name, folderPath: opts.body?.get?.('folderPath') });
      return jsonResponse({ id, url: `https://f.hubspotusercontent-eu1.net/hubfs/4242/${name}` });
    }
    const draftMatch = path.match(/^\/cms\/v3\/blogs\/posts\/([^/]+)\/draft$/);
    if (draftMatch) {
      const id = decodeURIComponent(draftMatch[1]);
      if (state.deleted.has(id) || !findPost(id)) return new Response('not found', { status: 404 });
      if (method === 'GET') return jsonResponse(state.drafts[id] || findPost(id));
      if (method === 'PATCH') {
        const body = JSON.parse(opts.body || '{}');
        const updated = { ...(state.drafts[id] || findPost(id)), ...body, id, updated: tick() };
        state.drafts[id] = updated;
        state.updated.push(updated);
        return jsonResponse(updated);
      }
    }
    const getMatch = path.match(/^\/cms\/v3\/blogs\/posts\/([^/]+)$/);
    if (getMatch && method === 'GET') {
      const id = decodeURIComponent(getMatch[1]);
      const found = findPost(id);
      if (found && !state.deleted.has(id)) return jsonResponse(found);
      return new Response('not found', { status: 404 });
    }
    return new Response('nope', { status: 404 });
  };

  return {
    state,
    editDraft(id, patch = {}) {
      state.drafts[id] = { ...(state.drafts[id] || findPost(id)), ...patch, updated: tick() };
    },
    deletePost(id) { state.deleted.add(String(id)); },
    publish(id) {
      const p = findPost(id);
      Object.assign(p, { state: 'PUBLISHED', url: `https://blog.example.com/p/${id}` });
    },
    restore() { globalThis.fetch = original; },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

module.exports = { makeMock };

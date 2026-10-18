'use strict';
// Mock-WP fuer die Blog-Sync-Integrationstests: gestubbtes globalThis.fetch mit
// der WP-REST-Oberflaeche, die lib/wp-client.js benutzt (users/me, posts list/
// get/create/update, media). `edit(id, patch)` simuliert eine Aenderung in
// WordPress (bumpt modified_gmt). `beforeWrite` (async, optional) laeuft in jedem
// Post-Create/-Update, bevor WordPress antwortet — so laesst sich ein lokaler
// Save WAEHREND des Pushs nachstellen. `media` zaehlt die Uploads.

function makeWpStub({ posts = [], me = { id: 1, name: 'Editor', capabilities: { edit_posts: true } } } = {}) {
  const state = {
    posts: posts.map(p => ({ ...p })),
    me,
    nextId: posts.reduce((m, p) => Math.max(m, p.id), 100) + 1,
    calls: [],
    media: [],
    beforeWrite: null,
  };

  function respond(status, body, headers = {}) {
    const hdr = new Map(Object.entries(headers));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: k => hdr.get(k) ?? hdr.get(k.toLowerCase()) ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
      // Der Client liest JSON mit Byte-Deckel (lib/sync/request.js#readJson).
      arrayBuffer: async () => {
        const buf = Buffer.from(JSON.stringify(body));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
      },
    };
  }

  state.fetch = async (rawUrl, init) => {
    const u = new URL(rawUrl);
    const method = (init?.method || 'GET').toUpperCase();
    state.calls.push({ url: rawUrl, method, body: init?.body });

    if (u.pathname === '/wp-json/wp/v2/users/me') return respond(200, state.me);

    if (u.pathname === '/wp-json/wp/v2/media' && method === 'POST') {
      const id = 5000 + state.media.length;
      const item = { id, source_url: `https://wp.test/wp-content/uploads/img-${id}.png` };
      state.media.push(item);
      return respond(201, item);
    }

    if (u.pathname === '/wp-json/wp/v2/posts' && method === 'GET') {
      const perPage = parseInt(u.searchParams.get('per_page') || '10', 10);
      const page = parseInt(u.searchParams.get('page') || '1', 10);
      const modifiedAfter = u.searchParams.get('modified_after');
      let pool = state.posts.slice();
      if (modifiedAfter) pool = pool.filter(p => (p.modified_gmt || '') > modifiedAfter);
      pool.sort((a, b) => (a.modified_gmt || '').localeCompare(b.modified_gmt || ''));
      const total = pool.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const slice = pool.slice((page - 1) * perPage, page * perPage);
      return respond(200, slice, {
        'X-WP-Total': String(total),
        'X-WP-TotalPages': String(totalPages),
      });
    }

    const updMatch = u.pathname.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
    if (updMatch && method === 'GET') {
      const post = state.posts.find(p => p.id === Number(updMatch[1]));
      return post ? respond(200, post) : respond(404, { code: 'rest_post_invalid_id' });
    }
    if (updMatch && method === 'POST') {
      const id = Number(updMatch[1]);
      const post = state.posts.find(p => p.id === id);
      if (!post) return respond(404, { code: 'rest_post_invalid_id' });
      if (state.beforeWrite) await state.beforeWrite({ id, method });
      const payload = JSON.parse(init.body || '{}');
      if (payload.title) post.title = { rendered: payload.title, raw: payload.title };
      if (payload.content) post.content = { rendered: payload.content, raw: payload.content };
      if (payload.excerpt) post.excerpt = { rendered: `<p>${payload.excerpt}</p>`, raw: payload.excerpt };
      if (payload.status) post.status = payload.status;
      post.modified_gmt = new Date().toISOString().replace('Z', '');
      return respond(200, post);
    }

    if (u.pathname === '/wp-json/wp/v2/posts' && method === 'POST') {
      if (state.beforeWrite) await state.beforeWrite({ id: null, method });
      const payload = JSON.parse(init.body || '{}');
      const newPost = {
        id: state.nextId++,
        title: { rendered: payload.title || '', raw: payload.title || '' },
        content: { rendered: payload.content || '', raw: payload.content || '' },
        excerpt: { rendered: '', raw: payload.excerpt || '' },
        status: payload.status || 'draft',
        slug: payload.slug || `post-${Date.now()}`,
        modified_gmt: new Date().toISOString().replace('Z', ''),
        date_gmt: new Date().toISOString().replace('Z', ''),
      };
      state.posts.push(newPost);
      return respond(201, newPost);
    }

    return respond(404, { code: 'rest_no_route' });
  };

  // Aenderung „in WordPress": Felder mergen, modified_gmt auf jetzt (+1 s, damit
  // der Stamp sicher juenger ist als alles, was der Test vorher sah).
  state.edit = (id, patch) => {
    const post = state.posts.find(p => p.id === id);
    Object.assign(post, patch);
    post.modified_gmt = new Date(Date.now() + 1000).toISOString().slice(0, 19);
    return post;
  };

  return state;
}

function installFetch(stub) {
  const prev = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  return () => { globalThis.fetch = prev; };
}

module.exports = { makeWpStub, installFetch };

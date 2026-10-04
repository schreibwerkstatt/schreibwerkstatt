'use strict';
// Mail-Templates.
// Pro Template: { subjectKey, render(ctx, locale) → { subject, html, text } }.
// HTML-Body escapest User-Input ueber _escHtml (Server-Mini-Helper, keine
// public/js/utils.js-Dep — Server-Pfad bleibt minimal).
//
// Locale-Auflösung passiert im Caller (lib/mailer.js): app_users.language
// → 'de' Fallback. Mail-eigene Strings (mail.subject.*, mail.body.*) leben als
// JSON-Lookup-Map hier; Job-Error-Keys (z.B. job.error.phase1Incomplete) werden
// via lib/i18n-server.js aus public/js/i18n/*.json gerendert, damit Admin-Mails
// den vollständigen Fehler inkl. Platzhalter sehen.

const { tServerParams } = require('./i18n-server');

const _esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// errorMsg ist ein i18n-Key (z.B. 'job.error.phase1Incomplete') aus failJob.
// Hier zur Mail-Locale aufloesen + {count}/{details}-Platzhalter ersetzen,
// damit der Admin nicht nur den Key sieht.
function _renderErrorMsg(msg, params, locale) {
  if (!msg || typeof msg !== 'string') return '—';
  if (!msg.includes('.') && !params) return msg;
  return tServerParams(msg, params, locale);
}

const { TEXT } = require('./mailer-templates/texts');

function _t(locale, key, params) {
  const dict = TEXT[locale] || TEXT.de;
  let str = dict[key] || TEXT.de[key] || key;
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => params[k] != null ? String(params[k]) : `{${k}}`);
}

function _passwordTemplate(kind) {
  const subjectKey = kind === 'reset' ? 'mail.subject.passwordReset' : 'mail.subject.passwordSet';
  const introKey   = kind === 'reset' ? 'mail.body.passwordReset.intro' : 'mail.body.passwordSet.intro';
  const ctaKey     = kind === 'reset' ? 'mail.body.passwordReset.cta'   : 'mail.body.passwordSet.cta';
  return {
    subjectKey,
    render(ctx, locale = 'de') {
      const params = {
        appName: ctx.appName || 'Schreibwerkstatt',
        passwordUrl: ctx.passwordUrl || '',
        expiresAt: ctx.expiresAt || '',
      };
      const subject = _t(locale, subjectKey, params);
      const intro   = _t(locale, introKey, params);
      const cta     = _t(locale, ctaKey, params);
      const expires = _t(locale, 'mail.body.password.expires', params);
      const footer  = _t(locale, 'mail.body.password.footer', params);
      const url = _esc(params.passwordUrl);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p>${_esc(cta)}</p>
<p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>
<p style="color:#666;font-size:0.9em">${_esc(expires)}</p>
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n${cta}\n${params.passwordUrl}\n\n${expires}\n\n${footer}`;
      return { subject, html, text };
    },
  };
}

function _passwordTemplates() {
  return { 'password-set': _passwordTemplate('set'), 'password-reset': _passwordTemplate('reset') };
}

const TEMPLATES = {
  invite: {
    subjectKey: 'mail.subject.invite',
    render(ctx, locale = 'de') {
      const params = {
        appName: ctx.appName || 'Schreibwerkstatt',
        inviterName: ctx.inviterName || ctx.invitedBy || 'Ein Admin',
        inviteUrl: ctx.inviteUrl || '',
        expiresAt: ctx.expiresAt || '',
        role: ctx.role || 'user',
      };
      const subject = _t(locale, 'mail.subject.invite', params);
      const intro    = _t(locale, 'mail.body.invite.intro', params);
      const cta      = _t(locale, 'mail.body.invite.cta', params);
      const expires  = _t(locale, 'mail.body.invite.expires', params);
      const footer   = _t(locale, 'mail.body.invite.footer', params);
      const url = _esc(params.inviteUrl);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p>${_esc(cta)}</p>
<p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>
<p style="color:#666;font-size:0.9em">${_esc(expires)}</p>
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n${cta}\n${params.inviteUrl}\n\n${expires}\n\n${footer}`;
      return { subject, html, text };
    },
  },

  'invite-reminder': {
    subjectKey: 'mail.subject.inviteReminder',
    render(ctx, locale = 'de') {
      const params = {
        appName: ctx.appName || 'Schreibwerkstatt',
        inviterName: ctx.inviterName || ctx.invitedBy || 'Ein Admin',
        inviteUrl: ctx.inviteUrl || '',
        expiresAt: ctx.expiresAt || '',
        role: ctx.role || 'user',
      };
      const subject = _t(locale, 'mail.subject.inviteReminder', params);
      const intro   = _t(locale, 'mail.body.inviteReminder.intro', params);
      const cta     = _t(locale, 'mail.body.inviteReminder.cta', params);
      const expires = _t(locale, 'mail.body.invite.expires', params);
      const footer  = _t(locale, 'mail.body.invite.footer', params);
      const url = _esc(params.inviteUrl);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p>${_esc(cta)}</p>
<p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>
<p style="color:#666;font-size:0.9em">${_esc(expires)}</p>
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n${cta}\n${params.inviteUrl}\n\n${expires}\n\n${footer}`;
      return { subject, html, text };
    },
  },

  // Setz- und Reset-Mail teilen ein Rendering und unterscheiden sich nur in
  // Betreff und Einleitung — zwei Kopien wuerden bei jeder Layout-Aenderung
  // auseinanderlaufen.
  ..._passwordTemplates(),

  'registration-request-admin': {
    subjectKey: 'mail.subject.registrationRequestAdmin',
    render(ctx, locale = 'de') {
      const params = {
        appName:     ctx.appName || 'Schreibwerkstatt',
        email:       ctx.email || '',
        displayName: ctx.displayName || '—',
        ip:          ctx.ip || '—',
        createdAt:   ctx.createdAt || '',
        adminUrl:    ctx.adminUrl || '',
        message:     ctx.message || '',
        source:      ctx.source || '',
        sourceNote:  ctx.sourceNote || '',
      };
      const subject  = _t(locale, 'mail.subject.registrationRequestAdmin', params);
      const intro    = _t(locale, 'mail.body.regReqAdmin.intro', params);
      const emailLn  = _t(locale, 'mail.body.regReqAdmin.email', params);
      const nameLn   = _t(locale, 'mail.body.regReqAdmin.name', params);
      const msgLn    = _t(locale, 'mail.body.regReqAdmin.message', params);
      const meta     = _t(locale, 'mail.body.regReqAdmin.meta', params);
      const cta      = _t(locale, 'mail.body.regReqAdmin.cta', params);
      const originLns = [
        params.source ? _t(locale, 'mail.body.regReqAdmin.source', params) : '',
        params.sourceNote ? _t(locale, 'mail.body.regReqAdmin.sourceNote', params) : '',
      ].filter(Boolean);
      const adminUrl = _esc(params.adminUrl);
      const msgBlock = params.message
        ? `<p style="margin:8px 0 0">${_esc(msgLn)}</p><blockquote style="margin:4px 0 0;padding:8px 12px;background:#f5f5f5;border-left:3px solid #ccc;white-space:pre-wrap">${_esc(params.message)}</blockquote>`
        : '';
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0">${[emailLn, nameLn, ...originLns].map(_esc).join('<br>')}</p>
${msgBlock}
<p style="color:#666;font-size:0.85em;margin-top:16px">${_esc(meta)}</p>
<p style="margin-top:24px">${_esc(cta)}</p>
<p><a href="${adminUrl}" style="display:inline-block;padding:10px 16px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${adminUrl}</a></p>
</body></html>`;
      const text = `${intro}\n\n${[emailLn, nameLn, ...originLns].join('\n')}\n` +
        (params.message ? `\n${msgLn}\n${params.message}\n` : '') +
        `\n${meta}\n\n${cta}\n${params.adminUrl}\n`;
      return { subject, html, text };
    },
  },

  'registration-approved': {
    subjectKey: 'mail.subject.registrationApproved',
    render(ctx, locale = 'de') {
      const params = {
        appName:   ctx.appName || 'Schreibwerkstatt',
        inviteUrl: ctx.inviteUrl || '',
        expiresAt: ctx.expiresAt || '',
      };
      const subject = _t(locale, 'mail.subject.registrationApproved', params);
      const intro   = _t(locale, 'mail.body.regApproved.intro', params);
      const cta     = _t(locale, 'mail.body.regApproved.cta', params);
      const expires = _t(locale, 'mail.body.regApproved.expires', params);
      const url = _esc(params.inviteUrl);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p>${_esc(cta)}</p>
<p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>
<p style="color:#666;font-size:0.9em">${_esc(expires)}</p>
</body></html>`;
      const text = `${intro}\n\n${cta}\n${params.inviteUrl}\n\n${expires}\n`;
      return { subject, html, text };
    },
  },

  'registration-denied': {
    subjectKey: 'mail.subject.registrationDenied',
    render(ctx, locale = 'de') {
      const params = {
        appName: ctx.appName || 'Schreibwerkstatt',
        reason:  ctx.reason || '',
      };
      const subject = _t(locale, 'mail.subject.registrationDenied', params);
      const intro   = _t(locale, 'mail.body.regDenied.intro', params);
      const reason  = params.reason ? _t(locale, 'mail.body.regDenied.reason', params) : '';
      const footer  = _t(locale, 'mail.body.regDenied.footer', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
${reason ? `<p style="color:#666">${_esc(reason)}</p>` : ''}
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n` + (reason ? `\n${reason}\n` : '') + `\n${footer}\n`;
      return { subject, html, text };
    },
  },

  'book-shared': {
    subjectKey: 'mail.subject.bookShared',
    render(ctx, locale = 'de') {
      const params = {
        appName:     ctx.appName || 'Schreibwerkstatt',
        inviterName: ctx.inviterName || ctx.invitedBy || '',
        bookName:    ctx.bookName || '',
        role:        ctx.role || 'viewer',
        bookUrl:     ctx.bookUrl || '',
      };
      params.roleLabel = _t(locale, `mail.body.bookShared.role.${params.role}`, params);
      const subject = _t(locale, 'mail.subject.bookShared', params);
      const intro   = _t(locale, 'mail.body.bookShared.intro', params);
      const cta     = _t(locale, 'mail.body.bookShared.cta', params);
      const noUrl   = _t(locale, 'mail.body.bookShared.noUrl', params);
      const footer  = _t(locale, 'mail.body.bookShared.footer', params);
      const url = _esc(params.bookUrl);
      const linkBlock = params.bookUrl
        ? `<p>${_esc(cta)}</p><p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>`
        : `<p>${_esc(noUrl)}</p>`;
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
${linkBlock}
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n` +
        (params.bookUrl ? `${cta}\n${params.bookUrl}\n` : `${noUrl}\n`) +
        `\n${footer}\n`;
      return { subject, html, text };
    },
  },

  'share-comment-owner': {
    subjectKey: 'mail.subject.shareComment',
    render(ctx, locale = 'de') {
      const params = {
        appName:     ctx.appName    || 'Schreibwerkstatt',
        targetName:  ctx.targetName || '—',
        bookName:    ctx.bookName   || '—',
        readerName:  ctx.readerName || '',
      };
      const subject = _t(locale, 'mail.subject.shareComment', params);
      const introKey = ctx.isReply
        ? (params.readerName ? 'mail.body.shareComment.reply' : 'mail.body.shareComment.replyAnon')
        : (params.readerName ? 'mail.body.shareComment.intro' : 'mail.body.shareComment.introAnon');
      const intro     = _t(locale, introKey, params);
      const quoteHdr  = _t(locale, 'mail.body.shareComment.quote', params);
      const commentHdr= _t(locale, 'mail.body.shareComment.comment', params);
      const cta       = _t(locale, 'mail.body.shareComment.cta', params);
      const footer    = _t(locale, 'mail.body.shareComment.footer', params);
      const url = _esc(ctx.appUrl || '');
      const quoteBlockHtml = ctx.anchorQuote
        ? `<p style="margin:16px 0 4px;color:#666;font-size:0.9em">${_esc(quoteHdr)}</p><blockquote style="margin:0;padding:8px 12px;background:#f5f5f5;border-left:3px solid #5a4a8e;font-style:italic;white-space:pre-wrap">${_esc(ctx.anchorQuote)}</blockquote>`
        : '';
      const ctaBlockHtml = ctx.appUrl
        ? `<p style="margin-top:20px">${_esc(cta)}</p><p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>`
        : '';
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
${quoteBlockHtml}
<p style="margin:16px 0 4px;color:#666;font-size:0.9em">${_esc(commentHdr)}</p>
<blockquote style="margin:0;padding:8px 12px;background:#fafafa;border-left:3px solid #ccc;white-space:pre-wrap">${_esc(ctx.snippet || '')}</blockquote>
${ctaBlockHtml}
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const quoteBlockTxt = ctx.anchorQuote ? `\n${quoteHdr}\n"${ctx.anchorQuote}"\n` : '';
      const ctaBlockTxt = ctx.appUrl ? `\n${cta}\n${ctx.appUrl}\n` : '';
      const text = `${intro}\n${quoteBlockTxt}\n${commentHdr}\n${ctx.snippet || ''}\n${ctaBlockTxt}\n${footer}\n`;
      return { subject, html, text };
    },
  },

  'share-reply-reader': {
    subjectKey: 'mail.subject.shareReply',
    render(ctx, locale = 'de') {
      const params = {
        appName:    ctx.appName    || 'Schreibwerkstatt',
        targetName: ctx.targetName || '—',
        bookName:   ctx.bookName   || '—',
        authorName: ctx.authorName || '',
      };
      const subject  = _t(locale, 'mail.subject.shareReply', params);
      const intro    = _t(locale, params.authorName ? 'mail.body.shareReply.intro' : 'mail.body.shareReply.introAnon', params);
      const quoteHdr = _t(locale, 'mail.body.shareReply.quote', params);
      const replyHdr = _t(locale, 'mail.body.shareReply.reply', params);
      const cta      = _t(locale, 'mail.body.shareReply.cta', params);
      const footer   = _t(locale, 'mail.body.shareReply.footer', params);
      const url = _esc(ctx.appUrl || '');
      const quoteBlockHtml = ctx.anchorQuote
        ? `<p style="margin:16px 0 4px;color:#666;font-size:0.9em">${_esc(quoteHdr)}</p><blockquote style="margin:0;padding:8px 12px;background:#f5f5f5;border-left:3px solid #5a4a8e;font-style:italic;white-space:pre-wrap">${_esc(ctx.anchorQuote)}</blockquote>`
        : '';
      const ctaBlockHtml = ctx.appUrl
        ? `<p style="margin-top:20px">${_esc(cta)}</p><p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>`
        : '';
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
${quoteBlockHtml}
<p style="margin:16px 0 4px;color:#666;font-size:0.9em">${_esc(replyHdr)}</p>
<blockquote style="margin:0;padding:8px 12px;background:#fafafa;border-left:3px solid #ccc;white-space:pre-wrap">${_esc(ctx.snippet || '')}</blockquote>
${ctaBlockHtml}
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const quoteBlockTxt = ctx.anchorQuote ? `\n${quoteHdr}\n"${ctx.anchorQuote}"\n` : '';
      const ctaBlockTxt = ctx.appUrl ? `\n${cta}\n${ctx.appUrl}\n` : '';
      const text = `${intro}\n${quoteBlockTxt}\n${replyHdr}\n${ctx.snippet || ''}\n${ctaBlockTxt}\n${footer}\n`;
      return { subject, html, text };
    },
  },

  'job-failed-admin': {
    subjectKey: 'mail.subject.jobFailedAdmin',
    render(ctx, locale = 'de') {
      const params = {
        appName:    ctx.appName    || 'Schreibwerkstatt',
        jobType:    ctx.jobType    || '—',
        jobId:      ctx.jobId      || '—',
        userEmail:  ctx.userEmail  || '—',
        bookId:     ctx.bookId     || '—',
        bookName:   ctx.bookName   || '—',
        errorMsg:   _renderErrorMsg(ctx.errorMsg, ctx.errorParams, locale),
        provider:   ctx.provider   || '—',
        model:      ctx.model      || '—',
        tokensIn:   ctx.tokensIn   || 0,
        tokensOut:  ctx.tokensOut  || 0,
        duration:   ctx.duration   || '—',
      };
      const subject  = _t(locale, 'mail.subject.jobFailedAdmin', params);
      const intro    = _t(locale, 'mail.body.jobFailedAdmin.intro', params);
      const fields   = _t(locale, 'mail.body.jobFailedAdmin.fields', params);
      const userLn   = _t(locale, 'mail.body.jobFailedAdmin.user', params);
      const bookLn   = _t(locale, 'mail.body.jobFailedAdmin.book', params);
      const errorLn  = _t(locale, 'mail.body.jobFailedAdmin.error', params);
      const modelLn  = _t(locale, 'mail.body.jobFailedAdmin.model', params);
      const tokensLn = _t(locale, 'mail.body.jobFailedAdmin.tokens', params);
      const durLn    = _t(locale, 'mail.body.jobFailedAdmin.duration', params);
      const jobIdLn  = _t(locale, 'mail.body.jobFailedAdmin.jobId', params);
      const stackHdr = _t(locale, 'mail.body.jobFailedAdmin.stackHeader', params);
      const logHdr   = _t(locale, 'mail.body.jobFailedAdmin.logHeader', params);
      const stackBlockHtml = ctx.errorStack
        ? `<p style="margin-top:20px;margin-bottom:4px"><strong>${_esc(stackHdr)}</strong></p><pre style="margin:0;padding:10px;background:#f5f5f5;border-left:3px solid #a00;font-family:ui-monospace,monospace;font-size:0.8em;white-space:pre-wrap;overflow-wrap:anywhere">${_esc(ctx.errorStack)}</pre>`
        : '';
      const logBlockHtml = ctx.logExcerpt
        ? `<p style="margin-top:20px;margin-bottom:4px"><strong>${_esc(logHdr)}</strong></p><pre style="margin:0;padding:10px;background:#fafafa;border-left:3px solid #888;font-family:ui-monospace,monospace;font-size:0.8em;white-space:pre-wrap;overflow-wrap:anywhere">${_esc(ctx.logExcerpt)}</pre>`
        : '';
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:800px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0;font-family:ui-monospace,monospace;font-size:0.9em">
${_esc(fields)}<br>${_esc(userLn)}<br>${_esc(bookLn)}<br>${_esc(modelLn)}<br>${_esc(tokensLn)}<br>${_esc(durLn)}<br>${_esc(jobIdLn)}
</p>
<p style="margin-top:16px;color:#a00"><strong>${_esc(errorLn)}</strong></p>
${stackBlockHtml}
${logBlockHtml}
</body></html>`;
      const stackBlockTxt = ctx.errorStack ? `\n\n${stackHdr}\n${ctx.errorStack}` : '';
      const logBlockTxt   = ctx.logExcerpt ? `\n\n${logHdr}\n${ctx.logExcerpt}` : '';
      const text = `${intro}\n\n${fields}\n${userLn}\n${bookLn}\n${modelLn}\n${tokensLn}\n${durLn}\n${jobIdLn}\n\n${errorLn}${stackBlockTxt}${logBlockTxt}\n`;
      return { subject, html, text };
    },
  },

  'token-cap-hit-admin': {
    subjectKey: 'mail.subject.tokenCapHitAdmin',
    render(ctx, locale = 'de') {
      const params = {
        appName:    ctx.appName    || 'Schreibwerkstatt',
        jobType:    ctx.jobType    || '—',
        jobId:      ctx.jobId      || '—',
        userEmail:  ctx.userEmail  || '—',
        bookId:     ctx.bookId     || '—',
        bookName:   ctx.bookName   || '—',
        provider:   ctx.provider   || '—',
        model:      ctx.model      || '—',
        maxTokens:  ctx.maxTokens  || '—',
      };
      const subject = _t(locale, 'mail.subject.tokenCapHitAdmin', params);
      const intro   = _t(locale, 'mail.body.tokenCapHitAdmin.intro', params);
      const userLn  = _t(locale, 'mail.body.jobFailedAdmin.user', params);
      const bookLn  = _t(locale, 'mail.body.jobFailedAdmin.book', params);
      const modelLn = _t(locale, 'mail.body.jobFailedAdmin.model', params);
      const jobIdLn = _t(locale, 'mail.body.jobFailedAdmin.jobId', params);
      const hint    = _t(locale, 'mail.body.tokenCapHitAdmin.hint', params);
      const logHdr  = _t(locale, 'mail.body.jobFailedAdmin.logHeader', params);
      const logBlockHtml = ctx.logExcerpt
        ? `<p style="margin-top:20px;margin-bottom:4px"><strong>${_esc(logHdr)}</strong></p><pre style="margin:0;padding:10px;background:#fafafa;border-left:3px solid #888;font-family:ui-monospace,monospace;font-size:0.8em;white-space:pre-wrap;overflow-wrap:anywhere">${_esc(ctx.logExcerpt)}</pre>`
        : '';
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:800px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0;font-family:ui-monospace,monospace;font-size:0.9em">
${_esc(userLn)}<br>${_esc(bookLn)}<br>${_esc(modelLn)}<br>max_tokens_out: ${_esc(params.maxTokens)}<br>${_esc(jobIdLn)}
</p>
<p style="margin-top:16px;color:#666;font-size:0.9em">${_esc(hint)}</p>
${logBlockHtml}
</body></html>`;
      const logBlockTxt = ctx.logExcerpt ? `\n\n${logHdr}\n${ctx.logExcerpt}` : '';
      const text = `${intro}\n\n${userLn}\n${bookLn}\n${modelLn}\nmax_tokens_out: ${params.maxTokens}\n${jobIdLn}\n\n${hint}${logBlockTxt}\n`;
      return { subject, html, text };
    },
  },

  'budget-overrun-user': {
    subjectKey: 'mail.subject.budgetOverrunUser',
    render(ctx, locale = 'de') {
      const params = {
        appName:   ctx.appName   || 'Schreibwerkstatt',
        userEmail: ctx.userEmail || '',
        period:    ctx.period    || '',
        usd:       ctx.usd       || '0',
        budget:    ctx.budget    || '0',
        mode:      ctx.mode      || 'soft',
      };
      const subject  = _t(locale, 'mail.subject.budgetOverrunUser', params);
      const intro    = _t(locale, 'mail.body.budgetOverrun.userIntro', params);
      const usage    = _t(locale, 'mail.body.budgetOverrun.usage', params);
      const modeLine = _t(locale, params.mode === 'hard' ? 'mail.body.budgetOverrun.modeHard' : 'mail.body.budgetOverrun.modeSoft', params);
      const footer   = _t(locale, 'mail.body.budgetOverrun.footer', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0">${_esc(usage)}</p>
<p style="margin-top:12px;color:#666">${_esc(modeLine)}</p>
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n${usage}\n${modeLine}\n\n${footer}\n`;
      return { subject, html, text };
    },
  },

  'budget-overrun-admin': {
    subjectKey: 'mail.subject.budgetOverrunAdmin',
    render(ctx, locale = 'de') {
      const params = {
        appName:   ctx.appName   || 'Schreibwerkstatt',
        userEmail: ctx.userEmail || '',
        period:    ctx.period    || '',
        usd:       ctx.usd       || '0',
        budget:    ctx.budget    || '0',
        mode:      ctx.mode      || 'soft',
      };
      const subject  = _t(locale, 'mail.subject.budgetOverrunAdmin', params);
      const intro    = _t(locale, 'mail.body.budgetOverrun.intro', params);
      const usage    = _t(locale, 'mail.body.budgetOverrun.usage', params);
      const modeLine = _t(locale, params.mode === 'hard' ? 'mail.body.budgetOverrun.modeHard' : 'mail.body.budgetOverrun.modeSoft', params);
      const footer   = _t(locale, 'mail.body.budgetOverrun.footer', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0">${_esc(usage)}</p>
<p style="margin-top:12px;color:#666">${_esc(modeLine)}</p>
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n${usage}\n${modeLine}\n\n${footer}\n`;
      return { subject, html, text };
    },
  },

  test: {
    subjectKey: 'mail.subject.test',
    render(ctx, locale = 'de') {
      const params = {
        appName: ctx.appName || 'Schreibwerkstatt',
        mode: ctx.mode || 'unknown',
        fromEmail: ctx.fromEmail || '',
      };
      const subject = _t(locale, 'mail.subject.test', params);
      const intro = _t(locale, 'mail.body.test.intro', params);
      const config = _t(locale, 'mail.body.test.config', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="color:#666;font-size:0.9em">${_esc(config)}</p>
</body></html>`;
      const text = `${intro}\n\n${config}`;
      return { subject, html, text };
    },
  },
};

function renderTemplate(name, ctx, locale = 'de') {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`unknown template: ${name}`);
  return tpl.render(ctx || {}, locale);
}

function listTemplates() {
  return Object.keys(TEMPLATES);
}

module.exports = { renderTemplate, listTemplates, TEMPLATES, _esc };

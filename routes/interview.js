'use strict';
// Interview-Transkription: Aufnahme hochladen, Transkript lesen, Sprecher
// benennen, O-Ton übernehmen.
//
// Am research-Haupt-Router gemountet (siehe routes/research.js) — das Transkript
// IST ein Recherche-Fundstück, kein eigenes Objekt daneben. Deshalb gilt hier
// dieselbe ACL wie dort: lesen ab `viewer`, schreiben ab `editor`, aufgelöst
// über das Buch des Fundstücks.
//
// Routen:
//   POST   /:id/audio           Aufnahme ablegen, kind wird 'transcript'
//   GET    /:id/audio           Aufnahme streamen (Range-fähig für den Player)
//   DELETE /:id/audio           Aufnahme löschen, Transkript behalten
//   GET    /:id/transcript      Kopf + Segmente + Sprecher
//   PUT    /:id/speaker/:key    Sprecher benennen / mit Quelle verknüpfen
//   POST   /:id/oton            O-Ton als Quelle vom Typ `interview` anlegen

const express = require('express');
const { emitItem, setItemKind, setItemDocText } = require('../db/research-items');
const {
  getTranscript, getAudio, getAudioMeta, getAudioRange, createTranscript, dropAudio,
  listSegments, getSegment, listSpeakers, speakerLabels, setSpeaker, speakerKeys,
} = require('../db/interview');
const {
  AUDIO_MAX_BYTES, extForMime, baseMime, transcriptionAvailable,
  transcriptToText, formatTimecode,
} = require('../lib/interview-transcribe');
const { createSource, linkSource, getSource } = require('../db/sources');
const { toIntId } = require('../lib/validate');
const { resolveByteRange } = require('../lib/http-util');
const { safeAudioMime, FALLBACK_MIME } = require('../lib/media-mime');
const { sessionEmail } = require('../lib/acl');
const { scopedItem } = require('./research-acl');
const searchIndex = require('../lib/search');
const logger = require('../logger');

const interviewMediaRouter = express.Router();
const jsonBody = express.json();
// Audio kommt als rohes Binary mit dem Datei-Mime im Content-Type — kein
// Multipart, gleiche Bauform wie der PDF- und Bild-Upload der Recherche-Karte.
const rawAudio = express.raw({ type: ['audio/*', 'video/mp4', 'video/webm'], limit: AUDIO_MAX_BYTES + 1024 });

const AUDIONAME_MAX = 200;
// Deckel einer Range-Antwort. 2 MB sind bei Sprach-Bitraten Minuten Audio — der
// Player fragt nach, bevor er sie abgespielt hat.
const AUDIO_RANGE_CHUNK = 2 * 1024 * 1024;

// Zugriffs-Vorspann: `scopedItem` aus routes/research-acl.js — dasselbe
// Fundstueck, dieselbe Buch-ACL wie im Board und in den Medien-Routen. Der Guard
// prueft die Rechte VOR jeder Bestandsfrage und erledigt den Login-Fall mit
// (401 NOT_LOGGED_IN aus dem Buch-Guard); eine eigene Login-Pruefung davor waere
// eine zweite Antwortform fuer denselben Fall.
//
// Kein Buchtyp-Gate: ein Transkript ist Recherche-Material und darf auch in
// einem Roman liegen — journalistisch ist erst der O-Ton-Weg in den Artikel, und
// der laeuft ueber die Quellen-Bibliothek.

function _cleanName(raw) {
  const s = String(raw || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, AUDIONAME_MAX) : null;
}

// ── Aufnahme hochladen ───────────────────────────────────────────────────────

interviewMediaRouter.post('/:id/audio', rawAudio, (req, res) => {
  const s = scopedItem(req, res, 'editor');
  if (!s) return;
  const { id, bookId } = s;

  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error_code: 'NO_AUDIO' });
  }
  if (req.body.length > AUDIO_MAX_BYTES) {
    return res.status(413).json({ error_code: 'AUDIO_TOO_LARGE', params: { max: AUDIO_MAX_BYTES } });
  }
  const mime = baseMime(req.headers['content-type']);
  if (!extForMime(mime)) {
    return res.status(415).json({ error_code: 'UNSUPPORTED_AUDIO' });
  }

  createTranscript(id, bookId, {
    buffer: req.body, mime, name: _cleanName(req.query.name),
  });
  // `kind` erst NACH der Ablage: schlägt der Insert fehl, soll das Fundstück
  // nicht als Transkript dastehen, hinter dem nichts liegt.
  setItemKind(id, 'transcript');
  logger.info(`[interview] Audio abgelegt item=${id} bytes=${req.body.length} mime=${mime}`);
  res.json({
    item: emitItem(id),
    transcript: getTranscript(id),
    // Der Client soll nicht raten müssen, ob ein Transkriptionslauf überhaupt
    // möglich ist — ohne Backend bleibt die Aufnahme ein Anhang.
    can_transcribe: transcriptionAvailable(),
  });
});

/**
 * Aufnahme streamen. Range-fähig, weil ein `<audio>`-Element sonst nicht
 * springen kann: ohne `Accept-Ranges` lädt der Browser bei jedem Klick auf eine
 * Zeitmarke die ganze Datei neu — bei einer Stunde Gespräch unbrauchbar.
 */
interviewMediaRouter.get('/:id/audio', (req, res) => {
  const s = scopedItem(req, res, 'viewer');
  if (!s) return;
  const { id } = s;
  const meta = getAudioMeta(id);
  if (!meta?.size) return res.status(404).json({ error_code: 'NO_AUDIO' });

  const size = meta.size;
  res.set('Content-Type', safeAudioMime(meta.audio_mime) || FALLBACK_MIME);
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('X-Content-Type-Options', 'nosniff');

  const range = resolveByteRange(req.headers.range, size, AUDIO_RANGE_CHUNK);
  if (!range) {
    // Voller Download ohne Range (Speichern-unter): der einzige Weg, der den
    // ganzen BLOB zieht. Ein Medien-Element fragt immer mit Range an.
    const row = getAudio(id);
    res.set('Content-Length', String(size));
    return res.send(row.audio);
  }
  if (range.unsatisfiable) {
    res.set('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  const { start, end } = range;
  const chunk = getAudioRange(id, start, end - start + 1);
  if (!chunk) return res.status(404).json({ error_code: 'NO_AUDIO' });
  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${size}`);
  res.set('Content-Length', String(chunk.length));
  res.send(chunk);
});

/** Aufnahme löschen, Wortlaut behalten. */
interviewMediaRouter.delete('/:id/audio', (req, res) => {
  const s = scopedItem(req, res, 'editor');
  if (!s) return;
  res.json({ transcript: dropAudio(s.id) });
});

// ── Transkript lesen ─────────────────────────────────────────────────────────

interviewMediaRouter.get('/:id/transcript', (req, res) => {
  const s = scopedItem(req, res, 'viewer');
  if (!s) return;
  const { id } = s;
  const head = getTranscript(id);
  if (!head) return res.status(404).json({ error_code: 'TRANSCRIPT_NOT_FOUND' });
  res.json({
    transcript: head,
    segments: listSegments(id),
    speakers: listSpeakers(id),
    speaker_keys: speakerKeys(id),
    can_transcribe: transcriptionAvailable(),
  });
});

// ── Sprecher benennen ────────────────────────────────────────────────────────

/**
 * Aus «SPEAKER_01» wird «Maria Keller». Danach wird der Volltext neu gesetzt,
 * damit die Namen auch in Suche und Semantik-Index stehen — sonst findet man
 * das Zitat nur unter dem Schlüssel, den niemand kennt.
 */
interviewMediaRouter.put('/:id/speaker/:key', jsonBody, (req, res) => {
  const s = scopedItem(req, res, 'editor');
  if (!s) return;
  const { id } = s;
  if (!getTranscript(id)) return res.status(404).json({ error_code: 'TRANSCRIPT_NOT_FOUND' });

  try {
    setSpeaker(id, req.params.key, {
      label: req.body?.label ?? null,
      rolle: req.body?.rolle ?? null,
      sourceId: req.body?.source_id ?? null,
    });
  } catch (e) {
    if (e.code === 'UNKNOWN_SPEAKER') return res.status(400).json({ error_code: 'UNKNOWN_SPEAKER' });
    throw e;
  }

  setItemDocText(id, transcriptToText(listSegments(id), speakerLabels(id)));
  searchIndex.upsertResearch(id);
  res.json({ speakers: listSpeakers(id) });
});

// ── O-Ton übernehmen ─────────────────────────────────────────────────────────

/**
 * Ein Redebeitrag wird zur Quelle vom CSL-Typ `interview`.
 *
 * Warum über die Quellen-Bibliothek und nicht als eigener Zitat-Typ: der
 * Apparat dafür steht schon — `oton_role`/`oton_channel`/`oton_date`/`oton_auth`
 * (Migration 267) samt Warnung bei fehlender Zitatautorisierung, und der
 * Einfüge-Pfad im Editor (`span.cite[data-src]` + `blockquote[data-src]`) trägt
 * jeden O-Ton bis in PDF, EPUB und Quellenverzeichnis. Ein zweiter Zitat-Träger
 * daneben müsste all das nachbauen.
 *
 * Die Route legt NUR die Quelle an und liefert Text und Stellenangabe zurück.
 * Ins Manuskript schreibt sie nicht — wo ein O-Ton steht, entscheidet der Autor
 * im Editor (gleiche Trennung wie bei der Quellen-Erkennung).
 */
interviewMediaRouter.post('/:id/oton', jsonBody, (req, res) => {
  const s = scopedItem(req, res, 'editor');
  if (!s) return;
  const { id, bookId } = s;
  const userEmail = sessionEmail(req);

  const segId = toIntId(req.body?.segment_id);
  const seg = segId ? getSegment(segId) : null;
  if (!seg || seg.item_id !== id) return res.status(404).json({ error_code: 'SEGMENT_NOT_FOUND' });

  const speakers = listSpeakers(id);
  const info = seg.speaker ? speakers[seg.speaker] : null;

  // Hat dieser Sprecher schon eine Quelle, wird sie wiederverwendet. Sonst
  // entstünde je O-Ton ein neuer Eintrag derselben Person in der Bibliothek —
  // und das Quellenverzeichnis listete sie fünfmal.
  if (info?.source_id) {
    const existing = getSource(info.source_id, bookId);
    if (existing) {
      return res.json({ source: existing, reused: true, ...(_otonPayload(seg, info)) });
    }
  }

  const head = getTranscript(id);
  const name = info?.label || (seg.speaker ? seg.speaker : null);
  if (!name) return res.status(400).json({ error_code: 'SPEAKER_UNNAMED' });

  const src = createSource(userEmail, {
    csl_type: 'interview',
    // Die sprechende Person IST die Autorin des O-Tons (CSL-Konvention beim Typ
    // `interview`). Als `literal`, weil die App den Namen nicht in Vor- und
    // Nachname zerlegen kann, ohne zu raten.
    authors: [{ literal: name }],
    title: head?.audio_name || `Interview ${name}`,
    oton_role: info?.rolle || null,
    // Kanal und Datum weiss die App nicht — sie werden NICHT geraten. Das
    // Quellen-Formular fragt sie ab, und ein leeres Feld ist dort sichtbar,
    // eine erfundene Angabe nicht.
    //
    // `oton_auth: 'ausstehend'` ist Absicht und kein Platzhalter: ein frisch
    // aus dem Transkript gezogener O-Ton IST unautorisiert, und die Quellen-
    // Karte warnt dann überall dort, wo er belegt wird (fields.js#otonBlocking).
    oton_auth: 'ausstehend',
    note: `O-Ton aus dem Transkript «${head?.audio_name || id}»`,
  });
  linkSource(bookId, src.id, userEmail);
  setSpeaker(id, seg.speaker, {
    label: info?.label || name, rolle: info?.rolle || null, sourceId: src.id,
  });
  logger.info(`[interview] O-Ton item=${id} segment=${segId} → Quelle ${src.id}`);
  res.json({ source: getSource(src.id, bookId), reused: false, ..._otonPayload(seg, info) });
});

/** Was der Editor zum Einfügen braucht: Wortlaut und Stellenangabe. Die
 *  Stellenangabe ist die Zeitmarke — bei einem Gespräch ist sie das, was die
 *  Seitenzahl bei einem Buch ist. */
function _otonPayload(seg, info) {
  return {
    text: seg.text,
    loc: seg.start_s == null ? '' : formatTimecode(seg.start_s),
    speaker: info?.label || seg.speaker || null,
  };
}

module.exports = { interviewMediaRouter };

'use strict';
// Transkriptions-Job: «Abbrechen» setzt die Transkript-Zeile auf ihren Stand vor
// dem Lauf zurück — auch wenn der Abbruch erst beim Lesen des Whisper-Bodys
// greift und transcribeAudio ihn als TRANSCRIBE_BAD_BODY meldet statt als
// AbortError. transcribeAudio ist gemockt.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('interview-cancel');

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const transcribe = require('../../lib/interview-transcribe');

// Mock VOR dem Require des Jobs: interview.js destrukturiert transcribeAudio beim Laden.
let nextTranscribe = async () => { throw new Error('nicht gesetzt'); };
transcribe.transcribeAudio = (...args) => nextTranscribe(...args);

const { createJob, jobs, jobAbortControllers } = require('../../routes/jobs/shared');
const { createTranscript, getTranscript, setStatus } = require('../../db/interview');
const { runInterviewJob } = require('../../routes/jobs/interview');

const USER = 'interview-cancel@example.com';
const BOOK = 83001;
appUsers.createUser({ email: USER });
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'IC', datetime('now'), datetime('now'))`).run(BOOK);

function newItem(status) {
  const itemId = db.prepare('INSERT INTO research_items (book_id, user_email) VALUES (?, ?)').run(BOOK, USER).lastInsertRowid;
  createTranscript(itemId, BOOK, { buffer: Buffer.from('audio'), mime: 'audio/mpeg', name: 'a.mp3' });
  setStatus(itemId, status);
  return itemId;
}

// Wie transcribeAudio: der Abbruch beim Body-Lesen wird zu TRANSCRIBE_BAD_BODY.
function abortDuringBodyRead(jobId) {
  return async () => {
    jobAbortControllers.get(jobId).abort();
    jobs.get(jobId).cancelled = true;
    const e = new Error('TRANSCRIBE_BAD_BODY');
    e.code = 'TRANSCRIBE_BAD_BODY';
    throw e;
  };
}

test('Abbruch beim Body-Lesen: Zeile kehrt zu «ready» zurück, kein Fehler am Transkript', async () => {
  const itemId = newItem('ready');
  const jobId = createJob('interview-transcribe', BOOK, USER, 'job.label.x', null, `i${itemId}`);
  nextTranscribe = abortDuringBodyRead(jobId);
  await runInterviewJob(jobId, BOOK, itemId, USER);
  const head = getTranscript(itemId);
  assert.equal(head.status, 'ready');
  assert.ok(!head.fehler, 'kein Fehlertext am Transkript');
});

test('echter Fehler ohne Abbruch: Zeile bekommt den Fehler', async () => {
  const itemId = newItem('ready');
  const jobId = createJob('interview-transcribe', BOOK, USER, 'job.label.x', null, `i${itemId}`);
  nextTranscribe = async () => { const e = new Error('TRANSCRIBE_BAD_BODY'); e.code = 'TRANSCRIBE_BAD_BODY'; throw e; };
  await runInterviewJob(jobId, BOOK, itemId, USER);
  const head = getTranscript(itemId);
  assert.equal(head.status, 'error');
  assert.equal(head.fehler, 'TRANSCRIBE_BAD_BODY');
});

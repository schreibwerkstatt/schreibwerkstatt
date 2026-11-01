// Reine Rechenkerne des Diktats — kein DOM, kein MediaRecorder, kein Netz.
// Darum ohne Browser testbar (tests/unit/stt-vad.test.mjs); die DOM- und
// Aufnahme-Pfade decken die E2E-Tests ab.
//
// Bleibt ein Methoden-Objekt (statt freier Funktionen), weil die Helfer sich
// gegenseitig ueber `this` rufen und alle vier Teilmodule in denselben
// Root-Scope gespreadet werden (siehe Facade ../stt-dictation.js).

const STT_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

// Bekannte Whisper-Halluzinationen bei stillen/unverstaendlichen Segmenten.
// EXACT trifft nur, wenn das ganze (normalisierte) Segment der Phrase gleicht;
// PATTERNS treffen eindeutige Untertitel-/Copyright-Marker, die in echtem
// Prosatext nicht vorkommen. Siehe `_isLikelyHallucination`.
const STT_HALLUCINATION_EXACT = new Set([
  'vielen dank',
  'vielen dank fürs zuschauen',
  'vielen dank fürs zuhören',
  'vielen dank für ihre aufmerksamkeit',
  'danke fürs zuschauen',
  'bis zum nächsten mal',
  'tschüss',
  'das war\'s',
  'untertitel',
  'untertitelung',
  'thank you',
  'thanks for watching',
]);
// Sender-Kuerzel, die Whisper aus Untertitel-Trainingsdaten mitbringt.
const STT_BROADCASTERS = '(zdf|ard|wdr|swr|ndr|orf|srf|mdr|br|funk)';
const STT_HALLUCINATION_PATTERNS = [
  /amara\.org/,
  // „Untertitel im Auftrag des ZDF, 2021", „Untertitelung des NDR": nur mit
  // Sender oder Jahr — „Die Untertitel liefen bis 2003 mit." beginnt anders.
  new RegExp(`^untertitel(ung)?\\b.*(\\b${STT_BROADCASTERS}\\b|\\b\\d{4}\\b)`),
  new RegExp(`\\bim auftrag (des|der|von)\\b.*\\b${STT_BROADCASTERS}\\b`),
  // Das ganze Segment ist nur ein Senderkuerzel (ggf. mit Jahr).
  new RegExp(`^${STT_BROADCASTERS}(,? \\d{4})?$`),
  /^(©|copyright\b.*\b\d{4}\b)/,
];

export const sttComputeMethods = {

  // RMS aus einem Time-Domain-Sample (Uint8Array, zentriert um 128).
  _computeRms(timeDomain) {
    if (!timeDomain || !timeDomain.length) return 0;
    let sum = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const v = (timeDomain[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / timeDomain.length);
  },

  // Segment-Schnitt-Entscheidung. Schneidet, wenn nach erkannter Sprache eine
  // Stille von >= silenceMs anhaelt, oder wenn die Sprechdauer maxSegmentS
  // ueberschreitet (Schutz gegen Dauer-Sprechen ohne Pause). Die Hoechstdauer
  // zaehlt ab dem ersten Sprechen (`voiceStart`), nicht ab Segmentbeginn —
  // sonst schnitte eine lange Denkpause den folgenden Satz nach wenigen
  // Silben mitten im Wort. Liegt vor dem Sprechen schon `trimSilenceMs` Stille
  // im Segment, kommt ein `trim`-Schnitt: das stille Segment wird verworfen
  // und neu begonnen — lange Stille vor dem Sprechen ist der haeufigste
  // Ausloeser fuer Whisper-Geisterphrasen.
  _computeVadCut({ rms, threshold, now, segmentStart, voiceStart, lastVoiceTs, hasVoice, silenceMs, maxSegmentS, trimSilenceMs }) {
    const voiced = rms >= threshold;
    if (hasVoice && (now - (voiceStart ?? segmentStart)) >= maxSegmentS * 1000) {
      return { cut: true, reason: 'max', voiced };
    }
    if (hasVoice && !voiced && (now - lastVoiceTs) >= silenceMs) {
      return { cut: true, reason: 'silence', voiced };
    }
    if (!hasVoice && !voiced && trimSilenceMs > 0 && (now - segmentStart) >= trimSilenceMs) {
      return { cut: true, reason: 'trim', voiced };
    }
    return { cut: false, voiced };
  },

  // Beste vom Browser unterstuetzte MediaRecorder-Mime. isSupported ist die
  // injizierte MediaRecorder.isTypeSupported-Funktion (testbar).
  _computeSttMime(isSupported) {
    for (const c of STT_MIME_CANDIDATES) {
      if (isSupported(c)) return c;
    }
    return '';
  },

  // Normalisiert ein Transkript-Segment fuer die Einfuegung: trimmt, kollabiert
  // interne Whitespace-Folgen (Whisper liefert gelegentlich Doppel-Leerzeichen
  // oder Zeilenumbrueche) und tilgt ein Leerzeichen DIREKT vor Satzzeichen
  // („Wort , dann" -> „Wort, dann"). Nicht vor „…": steht es fuer ausgelassene
  // Woerter, gehoert ein Leerzeichen davor („Und dann … nichts").
  _normalizeTranscript(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  },

  // Schreibt den ersten Buchstaben gross (ggf. nach einem oeffnenden Zeichen wie
  // Anfuehrung/Klammer). No-op, wenn der Text mit Ziffer/Satzzeichen beginnt
  // oder schon gross ist. Pure/testbar.
  _capitalizeSentenceStart(text) {
    return String(text || '').replace(
      /^([\s"'»«„“‚‘(\[]*)(\p{L})/u,
      (_, pre, ch) => pre + ch.toUpperCase(),
    );
  },

  // True, wenn der vorausgehende Text auf einem Satzendezeichen endet — auch
  // wenn danach noch schliessende Anfuehrungs-/Klammerzeichen stehen
  // („…her.«", „…?"", „…!)"). So erkennen wir vom Modell gesetzte Satzzeichen
  // (Whisper punktiert selbst) und ergaenzen keinen eigenen Punkt. Pure/testbar.
  _endsSentence(prevText) {
    const s = String(prevText || '').replace(/[\s"'’”“»«)\]]+$/u, '');
    return /[.!?…]$/.test(s);
  },

  // Fuegt vor dem Transkript ein Leerzeichen ein, wenn unmittelbar davor ein
  // Nicht-Whitespace steht und der neue Text nicht mit Satzzeichen beginnt —
  // damit Worte ueber Segmentgrenzen hinweg nicht zusammenkleben.
  //
  // Satzgrenzen folgen ausschliesslich der Punktierung des Modells: NUR wenn der
  // Vortext (bzw. der Doc-/Block-Anfang) auf einem Satzendezeichen steht, wird
  // der erste Buchstabe gross geschrieben. Eine blosse Sprechpause (Atemholen)
  // ist KEIN Satzende — wir ergaenzen weder einen eigenen Punkt noch eine
  // Grossschreibung, weil Whisper selbst punktiert und grossschreibt. `prevText`
  // ist der (Teil-)Text links vom Caret; das letzte Zeichen bestimmt die
  // Leerzeichen-Heuristik, der getrimmte Schwanz die Satzende-Erkennung
  // (`_endsSentence` erkennt Satzzeichen auch hinter schliessender Anfuehrung).
  _computeSpacedInsert(prevText, text) {
    let t = this._normalizeTranscript(text);
    if (!t) return '';
    const prev = String(prevText || '');
    const prevChar = prev ? prev[prev.length - 1] : '';
    if (!prevChar || this._endsSentence(prev)) t = this._capitalizeSentenceStart(t);
    if (!prevChar) return t;
    if (/\s/.test(prevChar)) return t; // schon Whitespace davor
    return this._startsGlued(t) ? t : ' ' + t;
  },

  // True, wenn ein Segment ohne Leerzeichen an den Vortext anschliesst:
  // schliessende Satzzeichen/Klammern. Ein Anfuehrungszeichen am Segmentanfang
  // oeffnet dagegen meist eine Rede (Er sagte: "Komm …") und bekommt ein
  // Leerzeichen — es schliesst nur, wenn direkt Leerzeichen, Satzzeichen oder
  // das Ende folgt. Ein Strich am Anfang ist ein Gedankenstrich. Pure/testbar.
  _startsGlued(text) {
    const t = String(text || '');
    return /^[,.;:!?…)\]]/.test(t) || /^["'’”“»«](?=$|[\s,.;:!?…)\]])/u.test(t);
  },

  // Endet ein Segment nur, weil die Hoechstdauer es mitten im Satz geschnitten
  // hat, setzt Whisper trotzdem einen Schlusspunkt (es sieht jedes Segment als
  // eigene Aeusserung). Diesen einen Punkt entfernen; Auslassungspunkte, „?",
  // „!" und ein Punkt vor schliessender Anfuehrung bleiben. Pure/testbar.
  _computeMidCutText(text) {
    return String(text || '').replace(/(?<!\.)\.$/, '');
  },

  // Whisper „halluziniert" bei stillen/unverstaendlichen Segmenten bekannte
  // Boilerplate-Phrasen (Video-Untertitel-Floskeln, Dank-/Abschiedsformeln).
  // True, wenn das GANZE Segment einer solchen Phrase entspricht — dann wird es
  // verworfen statt eingefuegt. Die Muster pruefen das ganze Segment bzw.
  // eindeutige Boilerplate (Sender nur zusammen mit „Untertitel"/„im Auftrag",
  // Copyright nur mit Jahreszahl), damit Prosa wie „Sie arbeitete beim SRF."
  // durchkommt. `uncertain` kommt vom Proxy (Whisper-Konfidenz): `false` = das
  // Modell hat sicher Sprache gehoert, dann ist auch ein „Tschüss." als
  // Dialogzeile echt; `null` = Backend liefert keine Konfidenz. Pure/testbar.
  _isLikelyHallucination(text, uncertain = null) {
    if (uncertain === false) return false;
    const norm = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/[.!?…»«„“”"'’\s]+$/u, '')
      .trim()
      .toLowerCase();
    if (!norm) return false;
    if (STT_HALLUCINATION_EXACT.has(norm)) return true;
    return STT_HALLUCINATION_PATTERNS.some((re) => re.test(norm));
  },

  // Effektiver VAD-Threshold aus gemessenem Geraeuschboden: leicht ueber dem
  // Rauschen, nie unter dem Admin-Wert und auf das 5-Fache gedeckelt (verhindert
  // Ueber-Unterdrueckung, falls waehrend der Kalibrierung doch gesprochen wurde).
  // Pure/testbar.
  _computeNoiseThreshold(noiseFloor, base) {
    const b = Number(base) || 0;
    const cand = (Number(noiseFloor) || 0) * 1.8 + 0.004;
    return Math.min(Math.max(b, cand), Math.max(b * 5, 0.08));
  },

  // Plausibilisierung am Caret: liefert true, wenn ein Whitespace direkt vor
  // dem Caret getilgt werden soll, weil das neue Segment mit Satzzeichen
  // beginnt (sonst entstuende „Wort , dann"). Pure/testbar.
  _computeEatPrevSpace(prevChar, text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return /\s/.test(prevChar) && /^[,.;:!?…]/.test(t);
  },
};

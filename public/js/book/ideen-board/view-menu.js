// Ansichts-Menü der Ideen-Board-Filterleiste (view-menu.html, Vertrag in
// public/js/view-menu.js). Ein Ort für die Frage „welche Spalten": oben, was
// ICH sehe (Erledigte/Verworfene einblenden, localStorage pro Buch), darunter,
// welche Stufen das BUCH verwendet (book_settings.ideen_stages, gilt für alle),
// am Ende der persönliche Auto-Erledigt-Check (app_users.ideen_auto_check).
// `offen` und `erledigt` sind fest, die übrigen schaltet das Buch zu.
// Abschalten heisst „nicht mehr anbieten" — Ideen, die schon dort stehen,
// behalten ihre Spalte, bis sie leer ist.
//
// Die Zahl am Knopf zählt nur die persönliche Ansicht (Erledigte/Verworfene):
// Buch-Stufen und Auto-Check sind Einstellungen, keine Abweichung des Blicks.

import { IDEE_OPTIONAL_STATUSES } from '../ideen-shared.js';

export const ideenBoardViewMenu = {
  viewMenuSpec() {
    const t = (k, p) => window.__app.t(k, p);
    const fixed = (st) => ({ kind: 'toggle', key: `stage:${st}`, label: this.statusLabel(st),
      on: true, counts: false, disabled: true, toggle: () => {} });
    const items = [
      { kind: 'toggle', key: 'showErledigt', on: this.showErledigt, label: t('ideenBoard.showErledigt'),
        toggle: () => { this.showErledigt = !this.showErledigt; } },
    ];
    if (this.statuses().includes('verworfen')) {
      items.push({ kind: 'toggle', key: 'showVerworfen', on: this.showVerworfen, label: t('ideenBoard.showVerworfen'),
        toggle: () => { this.showVerworfen = !this.showVerworfen; } });
    }
    items.push(
      { kind: 'sep', key: 'sep:stages' },
      { kind: 'header', key: 'h:stages', label: t('ideenBoard.stages.label') },
      fixed('offen'),
      ...IDEE_OPTIONAL_STATUSES.map(st => ({ kind: 'toggle', key: `stage:${st}`, label: this.statusLabel(st),
        on: this.isStageActive(st), counts: false, disabled: this.busy,
        toggle: () => this.toggleStage(st) })),
      fixed('erledigt'),
      { kind: 'hint', key: 'hint:stages', text: t('ideenBoard.stages.hint') },
      { kind: 'sep', key: 'sep:autoCheck' },
      { kind: 'toggle', key: 'autoCheck', on: this.autoCheckOn, counts: false, disabled: this.busy,
        label: t('ideenBoard.autoCheck.label'), toggle: () => this.toggleAutoCheck() },
      { kind: 'hint', key: 'hint:autoCheck', text: t('ideenBoard.autoCheck.hint') },
    );
    return { tip: t('ideenBoard.view.tip'), items };
  },
};

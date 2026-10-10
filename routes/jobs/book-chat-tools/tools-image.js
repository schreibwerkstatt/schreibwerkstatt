'use strict';
// Buch-Chat-Tool `generate_image`. Bewusste Ausnahme zum sonst geltenden
// Tool-Vertrag „Read-Only, deterministisch, kein KI-Call" (siehe
// docs/buchchat-tools.md): dieses Tool ruft einen externen Bild-Endpunkt und
// hat einen Seiteneffekt (persistiert das Bild). Es gibt KEIN Bild in den
// Loop zurueck — nur JSON-Metadaten —, weil tool_results JSON-serialisierbar
// sein muessen. Das Bild lebt in chat_images und wird ueber GET /chat/image/:id
// gestreamt; die image_id sammelt der Loop in ctx.images und persistiert sie in
// context_info.images der Assistant-Nachricht (Frontend-Anzeige).
//
// App-Philosophie: das Bild ist Weltaufbau-/Chat-Visualisierung und geht NIE in
// den Manuskript-Text.

const { generateImage, imageGenEnabled, ImageGenError } = require('../../../lib/image-gen');
const { insertChatImage } = require('../../../db/chat-images');

async function tool_generate_image(input, ctx) {
  if (!imageGenEnabled()) {
    return { error: 'Bildgenerierung ist nicht aktiviert.', errorKey: 'chat.toolError.imageDisabled' };
  }
  const prompt = String(input?.prompt || '').trim();
  if (!prompt) return { error: 'Pflichtfeld `prompt` fehlt.', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'prompt' } };
  const size = typeof input?.size === 'string' && input.size.trim() ? input.size.trim() : undefined;

  let result;
  try {
    result = await generateImage({ prompt, size, signal: ctx.jobSignal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    const code = e instanceof ImageGenError ? e.code : 'image_error';
    ctx.logger?.warn?.(`generate_image fehlgeschlagen (${code}): ${e.message}`);
    return { error: `Bildgenerierung fehlgeschlagen (${code}).`, errorKey: 'chat.toolError.imageFailed' };
  }

  const imageId = insertChatImage({
    sessionId: ctx.sessionId,
    prompt,
    mime: result.mime,
    size: result.size,
    image: result.buffer,
  });

  // Fuer die Frontend-Anzeige sammeln (Loop persistiert ctx.images in
  // context_info.images der Assistant-Nachricht).
  if (Array.isArray(ctx.images)) {
    ctx.images.push({ image_id: imageId, prompt, mime: result.mime });
  }

  return {
    image_id: imageId,
    mime: result.mime,
    size: result.size,
    note: 'Bild generiert und im Chat-Verlauf gespeichert. Es wird dem User unter deiner Antwort angezeigt — verweise in final_answer kurz darauf, gib aber KEINE Bild-URL aus. Das Bild geht nicht in den Buchtext.',
    ...(result.revisedPrompt ? { revised_prompt: result.revisedPrompt } : {}),
  };
}

module.exports = { tool_generate_image };

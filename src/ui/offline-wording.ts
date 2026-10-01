// The words every "a part of the app could not be downloaded" message shares
// (lazy-load-failure.md REQ-the-offline-sentence-points-at-play-offline). Four
// operations report a missing chunk in their own sentence — opening a surface,
// writing an MP3, scanning a QR, fitting a clip — and each used to type the
// offline clause out separately. Leaf module, no imports: the eager toast reads it.

/** The cause, offline: reads after "Couldn't <verb> … — ". */
export const NOT_DOWNLOADED_YET = "you're offline and this part of the app isn't downloaded yet";

/**
 * What prevents it next time (play-offline.md): the About card's Play offline
 * saves every chunk. Only ever shown offline — online, the fetch failed for some
 * other reason and an offline copy is not the answer.
 */
export const PLAY_OFFLINE_HINT = "Next time you're online, About → Play offline saves all of it.";

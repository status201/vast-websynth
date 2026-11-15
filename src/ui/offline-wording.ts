// The words every "a part of the app could not be downloaded" message shares
// (lazy-load-failure.md REQ-the-offline-sentence-points-at-play-offline). Four
// operations report a missing chunk in their own sentence — opening a surface,
// writing an MP3, scanning a QR, fitting a clip — and each used to type the
// offline clause out separately. The version-skew sentences live here too
// (version-skew.md), for the same reason. Leaf module, no imports: the eager toast reads it.

/** The cause, offline: reads after "Couldn't <verb> … — ". */
export const NOT_DOWNLOADED_YET = "you're offline and this part of the app isn't downloaded yet";

/**
 * What prevents it next time (play-offline.md): the About card's Play offline
 * saves every chunk. Only ever shown offline — online, the fetch failed for some
 * other reason and an offline copy is not the answer.
 */
export const PLAY_OFFLINE_HINT = "Next time you're online, About → Play offline saves all of it.";

/**
 * The cause when a newer release replaced the file this tab asked for
 * (version-skew.md REQ-a-stale-failure-offers-reload): reads after "Couldn't <verb> … — ".
 */
export const NEWER_VERSION_LIVE = 'a newer version of VAST is out';

/** What fixes it — the old URL will never come back, so the action is Reload, not Retry. */
export const RELOAD_TO_GET_IT = 'Reload to get it.';

/** The action label every version-skew toast carries. */
export const RELOAD_LABEL = 'Reload';

/** The heads-up when a newer release's worker claims this tab (version-skew.md REQ-a-takeover-by-a-newer-worker-is-announced). */
export const TAKEOVER_NOTICE = 'A newer version of VAST is running in another tab — reload to switch to it.';

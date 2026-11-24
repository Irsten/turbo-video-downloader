// Store build: replaces lib/external.js. Downloads through a helper program on the user's computer
// belong to the personal build only and are not part of the published extension. Same interface, nothing enabled.
export const EXTERNAL_ENABLED = false;
export const youtubeVideoId = () => null;
export const pageVideoCount = () => 0;
export const externalCard = () => null;
export const mountExternalSetup = () => {};
export const probeHost = () => Promise.reject(new Error('Not available in this version'));
export const downloadExternal = () => Promise.reject(new Error('Not available in this version'));
export const revealFile = () => Promise.resolve();
export const cleanupExternal = () => Promise.resolve();

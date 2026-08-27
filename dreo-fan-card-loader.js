// Register THIS file as the Lovelace resource, not dreo-fan-card.js:
//   /local/dreo-fan-card-loader.js   (type: JavaScript Module)
//
// It never changes, so the browser may cache it forever. Each page load it
// pulls the real card with a fresh query string, which the browser treats as a
// new URL and therefore always refetches. No more ?v=23.
//
// The cost is that the card is never cached either, so it re-downloads on every
// load. It is a single small file, which is a fair trade while iterating. Once
// things settle, register dreo-fan-card.js directly again to get caching back.

import(`/local/dreo-fan-card.js?t=${Date.now()}`);

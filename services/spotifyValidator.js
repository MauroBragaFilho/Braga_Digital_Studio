const SPOTIFY_TYPES = ['track', 'album', 'playlist', 'artist'];

const SPOTIFY_WEB_RE = /^(?:https?:\/\/)?(?:open\.)?spotify\.com\/(?:[a-z-]+\/)?(track|album|playlist|artist)\/[A-Za-z0-9]+(?:[/?#].*)?$/i;
const SPOTIFY_URI_RE = /^spotify:(track|album|playlist|artist):[A-Za-z0-9]+(?:[?#].*)?$/i;

function detectarSpotify(url) {
  const value = String(url || '').trim();
  const match = value.match(SPOTIFY_WEB_RE) || value.match(SPOTIFY_URI_RE);

  if (!match) {
    return {
      isSpotify: false,
      type: null
    };
  }

  const type = match[1].toLowerCase();
  return {
    isSpotify: true,
    type: SPOTIFY_TYPES.includes(type) ? type : null
  };
}

function validarSpotifyDownload(url) {
  const spotifyInfo = detectarSpotify(url);

  if (!spotifyInfo.isSpotify) {
    return {
      permitido: false,
      tipo: null,
      motivo: 'Link do Spotify não detectado.'
    };
  }

  if (spotifyInfo.type === 'artist') {
    return {
      permitido: false,
      tipo: 'artist',
      motivo: 'Links de artista não são suportados.'
    };
  }

  return {
    permitido: ['track', 'album', 'playlist'].includes(spotifyInfo.type),
    tipo: spotifyInfo.type
  };
}

module.exports = {
  detectarSpotify,
  validarSpotifyDownload
};

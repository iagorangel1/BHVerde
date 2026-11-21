// Public frontend configuration only. Never put database passwords or JWT secrets here.
const bhverdeApiHost = window.location.hostname || 'localhost';
const bhverdeLocalHost = bhverdeApiHost === 'localhost'
  || bhverdeApiHost === '127.0.0.1'
  || /^10(?:\.\d{1,3}){3}$/.test(bhverdeApiHost)
  || /^192\.168(?:\.\d{1,3}){2}$/.test(bhverdeApiHost)
  || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(bhverdeApiHost);
const bhverdeApiOrigin = bhverdeLocalHost
  ? `${window.location.protocol}//${bhverdeApiHost}:3000`
  : window.location.origin;
window.BHVERDE_API_BASE = window.BHVERDE_API_BASE || `${bhverdeApiOrigin}/api/v1`;

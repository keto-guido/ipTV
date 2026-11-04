'use strict';
// Real server.js with every path redirected to TEST_ROOT, so it can run beside production.
// No credentials and no ffmpeg binary: it cannot reach the provider or start an encode.
const path = require('path');
const { cfg } = require('../src/config');
const root = process.env.TEST_ROOT;
Object.assign(cfg, {
  DATA: path.join(root, 'data'), HLS: path.join(root, 'hls'), FFMPEG: path.join(root, 'no-ffmpeg.exe'),
  SECRETS_FILE: path.join(root, 'none'), JWT_SECRET_FILE: path.join(root, 'jwt'),
});
require('../src/server.js');

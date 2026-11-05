'use strict';
// Real server.js and real ffmpeg, in TEST_ROOT, with a lavfi test pattern in place of every upstream, a different size per channel. Can run beside production:
// no credentials, no provider. Forced to libx264 (phone only) so it takes no NVENC session away from a running stream;
// test/lavfi.test.js is where NVENC and the TV output are measured.
const cp = require('child_process');
const path = require('path');
const { cfg } = require('../src/config');
const root = process.env.TEST_ROOT;
Object.assign(cfg, { DATA: path.join(root, 'data'), HLS: path.join(root, 'hls'), SECRETS_FILE: path.join(root, 'none'), JWT_SECRET_FILE: path.join(root, 'jwt') });

const { spawn, spawnSync } = cp;
cp.spawnSync = (bin, args, o) => (args.includes('h264_nvenc') ? { status: 1 } : spawnSync(bin, args, o));
cp.spawn = (bin, args, o) => {
  const i = args.indexOf('-user_agent');
  if (i < 0) return spawn(bin, args, o); // slate
  const a = [...args];
  // Replaces -user_agent ... -rw_timeout ... -i <url>. The two pads become 0:v:0 and 0:a:0, so the maps stay as they are.
  const width = args[i + 5].endsWith('/2') ? 480 : 640;
  a.splice(i, 6, '-re', '-f', 'lavfi', '-i', `testsrc2=size=${width}x270:rate=30[out0];sine=frequency=440:sample_rate=48000[out1]`);
  return spawn(bin, a, o);
};

const provider = require('../src/provider');
provider.channel = id => ({ id, name: `Channel ${id}` });
provider.streamUrl = id => `http://stub.invalid/${id}`; // never opened: replaced above
require('../src/server.js');

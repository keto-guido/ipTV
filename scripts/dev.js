'use strict';
// Local development: loopback only, auth bypassed.
process.env.HOST = '127.0.0.1';
process.env.DEV_AUTH = '1';
require('../src/server.js');

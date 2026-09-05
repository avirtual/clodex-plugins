'use strict';

module.exports.activate = (host) => {
  host.ipc.handle('greet', (who) => ({ ok: true, text: `hello ${who}` }));
  host.log.info('activated');
};
